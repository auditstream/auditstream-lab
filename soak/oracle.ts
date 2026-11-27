/**
 * Pure invariant oracle, JSONL parser, and report formatter for `auditstream-lab` soak runs.
 *
 * Kept completely free of I/O so every invariant and failure mode is unit-tested
 * deterministically in `tests/soak.test.ts`.
 */

import type {
  ActorSpec,
  AppName,
  DirectSqlRecord,
  ExpectedActorSource,
  ExpectedEventSpec,
  ExpectedMutation,
  ExportedEvent,
  InvariantCheck,
  LatencySummary,
  OracleInput,
  SoakReport,
} from "./types.ts";

const APPS: readonly AppName[] = ["hono-drizzle", "prisma-api"];
const FORBIDDEN_MARKER_SUBSTRINGS: readonly string[] = [
  "Rolled back savepoint adjustment",
  "Should roll back",
  "secret-soak-",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pushSample(samples: string[], value: string, limit = 5): void {
  if (samples.length < limit) {
    samples.push(value);
  }
}

function getRequestId(event: ExportedEvent): string | null {
  const ctx = asRecord(event.context);
  return typeof ctx?.requestId === "string" ? ctx.requestId : null;
}

function getRecordNumericId(event: ExportedEvent): number | null {
  const rec = asRecord(event.record_id);
  return typeof rec?.id === "number" ? rec.id : null;
}

function getAfterStatus(event: ExportedEvent): string | null {
  const after = asRecord(event.after);
  return typeof after?.status === "string" ? after.status : null;
}

function hasExactAppCoverage(apps: readonly AppName[]): boolean {
  if (apps.length !== APPS.length) {
    return false;
  }
  const seen = new Set<AppName>(apps);
  return APPS.every((app) => seen.has(app));
}

function actorMatches(actualRaw: unknown, expected: ActorSpec): boolean {
  const actual = asRecord(actualRaw);
  if (!actual) {
    return false;
  }
  if (
    actual.type !== expected.type ||
    actual.id !== expected.id ||
    actual.tenant !== expected.tenant
  ) {
    return false;
  }
  if (!expected.onBehalfOf) {
    return actual.onBehalfOf == null;
  }
  const actualObo = asRecord(actual.onBehalfOf);
  return (
    actualObo !== null &&
    actualObo.type === expected.onBehalfOf.type &&
    actualObo.id === expected.onBehalfOf.id
  );
}

function containsForbiddenContent(event: ExportedEvent): string | null {
  const serialized = JSON.stringify({
    before: event.before ?? null,
    after: event.after ?? null,
    changed: event.changed ?? null,
  });
  if (serialized.includes("password_hash")) {
    return "password_hash";
  }
  for (const marker of FORBIDDEN_MARKER_SUBSTRINGS) {
    if (serialized.includes(marker)) {
      return marker;
    }
  }
  return null;
}

export function parseJsonlContent(content: string): {
  readonly events: ExportedEvent[];
  readonly parseErrors: number;
} {
  const events: ExportedEvent[] = [];
  let parseErrors = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (asRecord(parsed) === null) {
        parseErrors += 1;
      } else {
        events.push(parsed as ExportedEvent);
      }
    } catch {
      parseErrors += 1;
    }
  }
  return { events, parseErrors };
}

function computePercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

export function computeLatencies(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: computePercentile(sorted, 50),
    p95: computePercentile(sorted, 95),
    p99: computePercentile(sorted, 99),
  };
}

function indexEventsByRequestId(
  exportedByApp: Readonly<Record<AppName, readonly ExportedEvent[]>>,
): Map<string, ExportedEvent[]> {
  const byKey = new Map<string, ExportedEvent[]>();
  for (const app of APPS) {
    for (const ev of exportedByApp[app]) {
      const reqId = getRequestId(ev);
      if (!reqId) {
        continue;
      }
      const key = `${app}:${reqId}`;
      const list = byKey.get(key);
      if (list) {
        list.push(ev);
      } else {
        byKey.set(key, [ev]);
      }
    }
  }
  return byKey;
}

function checkExportIntegrity(input: OracleInput): InvariantCheck {
  let parseErrors = 0;
  let missingEventIds = 0;
  let duplicateEventIds = 0;
  let totalExported = 0;

  for (const app of APPS) {
    parseErrors += input.parseErrorsByApp[app];
    const seen = new Set<string>();
    for (const ev of input.exportedByApp[app]) {
      totalExported += 1;
      if (typeof ev.event_id !== "string" || ev.event_id.length === 0) {
        missingEventIds += 1;
        continue;
      }
      if (seen.has(ev.event_id)) {
        duplicateEventIds += 1;
      } else {
        seen.add(ev.event_id);
      }
    }
  }

  const passed = parseErrors === 0 && missingEventIds === 0 && duplicateEventIds === 0;
  return {
    name: "export_jsonl_integrity",
    passed,
    detail: passed
      ? `${totalExported} exported events parsed cleanly with 0 duplicate event_ids`
      : `parse_errors=${parseErrors}, missing_event_id=${missingEventIds}, duplicate_event_id=${duplicateEventIds}`,
  };
}

function matchesEventSpec(ev: ExportedEvent, exp: ExpectedEventSpec): boolean {
  return (
    ev.source === exp.source &&
    (ev.table_name ?? null) === exp.tableName &&
    ev.op === exp.op &&
    getRecordNumericId(ev) === exp.recordId
  );
}

function verifyMutationEvents(
  mutation: ExpectedMutation,
  events: readonly ExportedEvent[],
  samples: string[],
): { readonly missing: number; readonly extra: number } {
  const used = new Set<number>();
  let missing = 0;
  for (const exp of mutation.expectedEvents) {
    const idx = events.findIndex((ev, i) => !used.has(i) && matchesEventSpec(ev, exp));
    if (idx >= 0) {
      used.add(idx);
    } else {
      missing += 1;
      pushSample(
        samples,
        `${mutation.app}/${mutation.kind}/${mutation.requestId}(missing ${exp.op}:${exp.recordId})`,
      );
    }
  }
  const extra = Math.max(0, events.length - used.size);
  if (extra > 0) {
    pushSample(samples, `${mutation.app}/${mutation.kind}/${mutation.requestId}(extra=${extra})`);
  }
  return { missing, extra };
}

function checkCommittedCompleteness(
  input: OracleInput,
  byReq: ReadonlyMap<string, readonly ExportedEvent[]>,
): InvariantCheck {
  const expectedByApp: Record<AppName, number> = { "hono-drizzle": 0, "prisma-api": 0 };
  let missing = 0;
  let extra = 0;
  const samples: string[] = [];

  for (const mutation of input.expectedMutations) {
    expectedByApp[mutation.app] += mutation.expectedEvents.length;
    const events = byReq.get(`${mutation.app}:${mutation.requestId}`) ?? [];
    const res = verifyMutationEvents(mutation, events, samples);
    missing += res.missing;
    extra += res.extra;
  }

  const expectedTotal = expectedByApp["hono-drizzle"] + expectedByApp["prisma-api"];
  const missingAppCoverage = APPS.filter((app) => expectedByApp[app] === 0);
  const passed = missingAppCoverage.length === 0 && missing === 0 && extra === 0;
  const failureContext =
    samples.join(", ") ||
    (missingAppCoverage.length > 0 ? `zero mutations for ${missingAppCoverage.join(",")}` : "none");

  return {
    name: "committed_mutations_exported",
    passed,
    detail: passed
      ? `${expectedTotal}/${expectedTotal} committed 2xx mutation events present in exported JSONL`
      : `missing=${missing}/${expectedTotal}, extra=${extra} (${failureContext})`,
  };
}

function countForbiddenRequestHits(
  input: OracleInput,
  byReq: ReadonlyMap<string, readonly ExportedEvent[]>,
  samples: string[],
): number {
  let hits = 0;
  for (const rec of input.forbiddenRequests) {
    const events = byReq.get(`${rec.app}:${rec.requestId}`);
    if (events && events.length > 0) {
      hits += events.length;
      pushSample(samples, `${rec.reason}:${rec.app}/${rec.requestId}`);
    }
  }
  return hits;
}

function countForbiddenPayloadHits(input: OracleInput, samples: string[]): number {
  let hits = 0;
  for (const app of APPS) {
    for (const ev of input.exportedByApp[app]) {
      const marker = containsForbiddenContent(ev);
      if (marker) {
        hits += 1;
        pushSample(samples, `payload(${marker})@${app}`);
      }
    }
  }
  return hits;
}

function checkNoRollbacksOrExcludedLeaks(
  input: OracleInput,
  byReq: ReadonlyMap<string, readonly ExportedEvent[]>,
): InvariantCheck {
  const samples: string[] = [];
  const forbiddenReqHits = countForbiddenRequestHits(input, byReq, samples);
  const forbiddenPayloadHits = countForbiddenPayloadHits(input, samples);
  const hasRollbackCheck = input.forbiddenRequests.some((r) => r.reason === "rollback");
  const missingExcludedApps = APPS.filter(
    (app) => !input.forbiddenRequests.some((r) => r.app === app && r.reason === "excluded-only"),
  );
  const hasExcludedCheck = missingExcludedApps.length === 0;
  const passed =
    hasRollbackCheck && hasExcludedCheck && forbiddenReqHits === 0 && forbiddenPayloadHits === 0;

  const missingCoverage = [
    ...(hasRollbackCheck ? [] : ["rollback"]),
    ...(hasExcludedCheck ? [] : [`excluded-only(${missingExcludedApps.join(",")})`]),
  ];
  const failureDetail =
    samples.join(", ") ||
    (missingCoverage.length > 0 ? `missing checks: ${missingCoverage.join(",")}` : "none");

  return {
    name: "zero_rollbacks_and_excluded_noops",
    passed,
    detail: passed
      ? `0 rolled-back writes, 0 excluded-only no-ops (${input.forbiddenRequests.length} checked), and 0 secret leaks`
      : `checked=${input.forbiddenRequests.length}, forbidden_request_events=${forbiddenReqHits}, forbidden_payload_hits=${forbiddenPayloadHits} (${failureDetail})`,
  };
}

function verifyRequestAttribution(
  app: AppName,
  requestId: string,
  actor: ActorSpec,
  expectedSource: ExpectedActorSource,
  byReq: ReadonlyMap<string, readonly ExportedEvent[]>,
  samples: string[],
): { readonly checked: number; readonly mismatches: number } {
  const events = byReq.get(`${app}:${requestId}`) ?? [];
  let mismatches = 0;
  for (const ev of events) {
    if (!actorMatches(ev.actor, actor) || ev.actor_source !== expectedSource) {
      mismatches += 1;
      pushSample(
        samples,
        `${app}/${requestId}(expected=${actor.type}:${actor.id}/${expectedSource}, got=${JSON.stringify(ev.actor)}/${String(ev.actor_source)})`,
      );
    }
  }
  return { checked: events.length, mismatches };
}

function isDirectSqlEvent(ev: ExportedEvent, status: string | null): boolean {
  return ev.source === "db" && ev.table_name === "invoice" && ev.op === "INSERT" && status !== null;
}

function verifySingleDirectSql(
  record: DirectSqlRecord,
  exported: readonly ExportedEvent[],
  samples: string[],
): { readonly checked: number; readonly issues: number } {
  const matching = exported.filter((ev) => {
    const status = getAfterStatus(ev);
    return isDirectSqlEvent(ev, status) && status === record.markerStatus;
  });
  if (matching.length === 0) {
    pushSample(samples, `missing_direct_sql:${record.app}/${record.markerStatus}`);
    return { checked: 0, issues: 1 };
  }
  let issues = 0;
  if (matching.length !== 1) {
    issues += matching.length - 1;
    pushSample(
      samples,
      `duplicate_direct_sql:${record.app}/${record.markerStatus}(count=${matching.length})`,
    );
  }
  for (const ev of matching) {
    if (ev.actor !== null || ev.actor_source !== null || ev.context !== null) {
      issues += 1;
      pushSample(
        samples,
        `direct_sql_bleed:${record.app}/${record.markerStatus}(actor=${JSON.stringify(ev.actor)},source=${String(ev.actor_source)},ctx=${JSON.stringify(ev.context)})`,
      );
    }
  }
  return { checked: matching.length, issues };
}

function isAccountedEvent(
  app: AppName,
  ev: ExportedEvent,
  knownRequestKeys: ReadonlySet<string>,
  directMarkers: ReadonlySet<string>,
): boolean {
  const reqId = getRequestId(ev);
  if (reqId !== null && knownRequestKeys.has(`${app}:${reqId}`)) {
    return true;
  }
  const status = getAfterStatus(ev);
  return isDirectSqlEvent(ev, status) && status !== null && directMarkers.has(status);
}

function countUnaccountedOrInvalidEvents(
  input: OracleInput,
  knownRequestKeys: ReadonlySet<string>,
  directMarkersByApp: Readonly<Record<AppName, ReadonlySet<string>>>,
  samples: string[],
): number {
  let unaccounted = 0;
  for (const app of APPS) {
    for (const ev of input.exportedByApp[app]) {
      if (ev.actor_source === "invalid") {
        unaccounted += 1;
        pushSample(samples, `invalid_actor_source@${app}`);
      } else if (!isAccountedEvent(app, ev, knownRequestKeys, directMarkersByApp[app])) {
        unaccounted += 1;
        pushSample(samples, `unaccounted_event:${app}/${getRequestId(ev) ?? "no-req-id"}`);
      }
    }
  }
  return unaccounted;
}

function checkActorAttribution(
  input: OracleInput,
  byReq: ReadonlyMap<string, readonly ExportedEvent[]>,
): InvariantCheck {
  const samples: string[] = [];
  const knownRequestKeys = new Set<string>();
  const checkedByApp: Record<AppName, number> = { "hono-drizzle": 0, "prisma-api": 0 };
  let mismatches = 0;

  for (const m of input.expectedMutations) {
    knownRequestKeys.add(`${m.app}:${m.requestId}`);
    const res = verifyRequestAttribution(
      m.app,
      m.requestId,
      m.actor,
      m.actorSource,
      byReq,
      samples,
    );
    checkedByApp[m.app] += res.checked;
    mismatches += res.mismatches;
  }
  for (const a of input.abortedRequests) {
    knownRequestKeys.add(`${a.app}:${a.requestId}`);
    const res = verifyRequestAttribution(
      a.app,
      a.requestId,
      a.actor,
      a.actorSource,
      byReq,
      samples,
    );
    checkedByApp[a.app] += res.checked;
    mismatches += res.mismatches;
  }

  const directMarkersByApp: Record<AppName, Set<string>> = {
    "hono-drizzle": new Set<string>(),
    "prisma-api": new Set<string>(),
  };
  const directCheckedByApp: Record<AppName, number> = { "hono-drizzle": 0, "prisma-api": 0 };
  let directBleed = 0;
  for (const d of input.directSqlWrites) {
    directMarkersByApp[d.app].add(d.markerStatus);
    const res = verifySingleDirectSql(d, input.exportedByApp[d.app], samples);
    directCheckedByApp[d.app] += res.checked;
    directBleed += res.issues;
  }

  const unaccounted = countUnaccountedOrInvalidEvents(
    input,
    knownRequestKeys,
    directMarkersByApp,
    samples,
  );
  const checkedEvents = checkedByApp["hono-drizzle"] + checkedByApp["prisma-api"];
  const directChecked = directCheckedByApp["hono-drizzle"] + directCheckedByApp["prisma-api"];
  const missingHttpApps = APPS.filter((app) => checkedByApp[app] === 0);
  const missingDirectApps = APPS.filter((app) => directCheckedByApp[app] === 0);

  const passed =
    mismatches === 0 &&
    directBleed === 0 &&
    unaccounted === 0 &&
    missingHttpApps.length === 0 &&
    missingDirectApps.length === 0;

  const missingCoverageText = `missing coverage: http=${missingHttpApps.join(",")}, direct=${missingDirectApps.join(",")}`;
  const failureDetail = samples.join(", ") || missingCoverageText;

  return {
    name: "zero_actor_attribution_leaks",
    passed,
    detail: passed
      ? `${checkedEvents} HTTP/app events + ${directChecked} direct unattributed SQL writes verified with 0 mismatches/bleed`
      : `mismatches=${mismatches}, direct_sql_bleed=${directBleed}, unaccounted=${unaccounted} (${failureDetail})`,
  };
}

function checkPreparedStatements(input: OracleInput): InvariantCheck {
  const problems: string[] = [];
  let totalBackends = 0;
  for (const probe of input.preparedStatements) {
    totalBackends += probe.distinctBackends;
    if (probe.leakedCount !== 0 || probe.distinctBackends < probe.expectedBackends) {
      problems.push(
        `${probe.app}(backends=${probe.distinctBackends}/${probe.expectedBackends}, leaked=${probe.leakedCount})`,
      );
    }
  }
  const hasAllApps = hasExactAppCoverage(input.preparedStatements.map((p) => p.app));
  const passed = hasAllApps && problems.length === 0;
  return {
    name: "zero_prepared_statement_leaks",
    passed,
    detail: passed
      ? `0 auditstream= entries across ${totalBackends} distinct pooled PgBouncer backend sessions`
      : `prepared statement probe failed: ${problems.join(", ") || "missing or duplicate app probe"}`,
  };
}

function checkTamperProtection(input: OracleInput): InvariantCheck {
  const { attempts, rejected42501, unexpectedErrors } = input.tamper;
  const passed = attempts > 0 && rejected42501 === attempts && unexpectedErrors.length === 0;
  return {
    name: "tamper_protection_42501",
    passed,
    detail: passed
      ? `${rejected42501}/${attempts} app_user tamper attempts rejected with SQLSTATE 42501`
      : `rejected42501=${rejected42501}/${attempts}, unexpected=${unexpectedErrors.slice(0, 3).join("; ")}`,
  };
}

function checkFinalVerify(input: OracleInput): InvariantCheck {
  const failed = input.verifyResults.filter((v) => !v.ok || v.findingsCount !== 0);
  const hasAllApps = hasExactAppCoverage(input.verifyResults.map((v) => v.app));
  const passed = hasAllApps && failed.length === 0;
  const failedSummary = failed
    .map((f) => `${f.app}(ok=${f.ok},findings=${f.findingsCount})`)
    .join(", ");
  return {
    name: "final_auditstream_verify",
    passed,
    detail: passed
      ? `auditstream verify exited 0 with 0 findings on ${APPS.join(" and ")}`
      : `verify failed: ${failedSummary || "missing or duplicate verify results"}`,
  };
}

function checkZeroHttpErrors(input: OracleInput): InvariantCheck {
  const { http5xxCount, unexpectedHttpCount, unexpectedHttpSamples, totalRequests } = input.metrics;
  const passed = totalRequests > 0 && http5xxCount === 0 && unexpectedHttpCount === 0;
  const sampleSummary = unexpectedHttpSamples.slice(0, 5).join(", ") || "none";
  return {
    name: "zero_http_5xx_errors",
    passed,
    detail: passed
      ? `0 HTTP 5xx or unexpected status responses across ${totalRequests} soak requests`
      : `http_5xx=${http5xxCount}, unexpected_http=${unexpectedHttpCount} across ${totalRequests} requests (${sampleSummary})`,
  };
}

export function evaluateOracle(input: OracleInput): SoakReport {
  const byReq = indexEventsByRequestId(input.exportedByApp);
  const invariants: InvariantCheck[] = [
    checkExportIntegrity(input),
    checkCommittedCompleteness(input, byReq),
    checkNoRollbacksOrExcludedLeaks(input, byReq),
    checkActorAttribution(input, byReq),
    checkPreparedStatements(input),
    checkTamperProtection(input),
    checkFinalVerify(input),
    checkZeroHttpErrors(input),
  ];

  const rawElapsedSeconds = Math.max(0.001, input.metrics.elapsedMs / 1000);
  const elapsedSeconds = Number(rawElapsedSeconds.toFixed(2));
  const rps = Number((input.metrics.totalRequests / rawElapsedSeconds).toFixed(2));
  const exportedEvents =
    input.exportedByApp["hono-drizzle"].length + input.exportedByApp["prisma-api"].length;

  return {
    passed: invariants.every((check) => check.passed),
    runId: input.metrics.runId,
    durationSeconds: input.metrics.durationSeconds,
    elapsedSeconds,
    concurrency: input.metrics.concurrency,
    requests: input.metrics.totalRequests,
    rps,
    latencyMs: computeLatencies(input.metrics.latenciesMs),
    exportedEvents,
    exportCycles: input.metrics.exportCycles,
    committedMutations: input.expectedMutations.length,
    abortedRequests: input.abortedRequests.length,
    activityReads: input.metrics.activityReads,
    tamperAttempts: input.tamper.attempts,
    invariants,
  };
}

function escapeMarkdownCell(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll(/\r\n|[\r\n]/g, " ")
    .replaceAll("|", String.raw`\|`);
}

export function formatMarkdownReport(report: SoakReport): string {
  const statusBadge = report.passed ? "PASS" : "FAIL";
  const lines = [
    `# Auditstream Lab Soak Report — ${statusBadge}`,
    "",
    `- **Run ID:** \`${report.runId}\``,
    `- **Duration / Elapsed:** ${report.durationSeconds}s target / ${report.elapsedSeconds}s actual`,
    `- **Concurrency:** ${report.concurrency} parallel workers`,
    `- **Requests:** ${report.requests} (${report.rps} req/s)`,
    `- **Latency (ms):** p50=${report.latencyMs.p50} | p95=${report.latencyMs.p95} | p99=${report.latencyMs.p99}`,
    `- **Exported events:** ${report.exportedEvents} (cycles: hono-drizzle=${report.exportCycles["hono-drizzle"]}, prisma-api=${report.exportCycles["prisma-api"]})`,
    `- **Workload mix:** ${report.committedMutations} committed mutations, ${report.activityReads} activity reads, ${report.abortedRequests} mid-flight aborts, ${report.tamperAttempts} tamper attempts`,
    "",
    "| Invariant | Status | Detail |",
    "| --- | --- | --- |",
    ...report.invariants.map(
      (check) =>
        `| \`${check.name}\` | **${check.passed ? "PASS" : "FAIL"}** | ${escapeMarkdownCell(check.detail)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
