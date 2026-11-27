import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeLatencies,
  evaluateOracle,
  formatMarkdownReport,
  parseJsonlContent,
} from "../soak/oracle.ts";
import type { ActorSpec, AppName, ExportedEvent, OracleInput } from "../soak/types.ts";
import { createWorkloadRecorder, pickActor, runConcurrentWorkers } from "../soak/workload.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = resolve(TEST_DIR, "..");
const RUN_SH = resolve(LAB_ROOT, "soak", "run.sh");

const ALICE: ActorSpec = { type: "user", id: "user_1", tenant: "tenant_1" };
const AGENT_BOB: ActorSpec = {
  type: "ai_agent",
  id: "agent_2",
  tenant: "tenant_1",
  onBehalfOf: { type: "user", id: "user_7" },
};

function makeBaselineInput(): OracleInput {
  const honoEvents: ExportedEvent[] = [
    {
      event_id: "evt-h1",
      source: "db",
      table_name: "invoice",
      op: "INSERT",
      record_id: { id: 10 },
      after: { id: 10, status: "draft", total: "50.00" },
      actor: ALICE,
      actor_source: "comment",
      context: { source: "lab/hono-drizzle", requestId: "req-h-1" },
    },
    {
      event_id: "evt-h2",
      source: "db",
      table_name: "invoice",
      op: "UPDATE",
      record_id: { id: 10 },
      before: { status: "draft" },
      after: { status: "finalized", total: "125.50" },
      changed: ["status", "total"],
      actor: AGENT_BOB,
      actor_source: "comment",
      context: { source: "lab/hono-drizzle", requestId: "req-h-2" },
    },
    {
      event_id: "evt-h3",
      source: "db",
      table_name: "line_item",
      op: "INSERT",
      record_id: { id: 101 },
      after: { id: 101, invoice_id: 10, description: "Soak line", amount: "125.50" },
      actor: AGENT_BOB,
      actor_source: "comment",
      context: { source: "lab/hono-drizzle", requestId: "req-h-2" },
    },
    {
      event_id: "evt-h4",
      source: "db",
      table_name: "invoice",
      op: "INSERT",
      record_id: { id: 11 },
      after: { id: 11, status: "direct_sql_run1_1", total: "1.00" },
      actor: null,
      actor_source: null,
      context: null,
    },
  ];

  const prismaEvents: ExportedEvent[] = [
    {
      event_id: "evt-p1",
      source: "db",
      table_name: "invoice",
      op: "UPDATE",
      record_id: { id: 20 },
      before: { status: "draft" },
      after: { status: "approved", total: "80.00" },
      changed: ["status"],
      actor: AGENT_BOB,
      actor_source: "set_config",
      context: { source: "lab/prisma-api", requestId: "req-p-1" },
    },
    {
      event_id: "evt-p2",
      source: "app",
      table_name: null,
      op: "invoice.exported",
      record_id: { id: 20 },
      after: { format: "csv" },
      actor: ALICE,
      actor_source: "set_config",
      context: { source: "lab/prisma-api", requestId: "req-p-2" },
    },
    {
      event_id: "evt-p3",
      source: "db",
      table_name: "invoice",
      op: "INSERT",
      record_id: { id: 21 },
      after: { id: 21, status: "direct_sql_run1_2", total: "1.00" },
      actor: null,
      actor_source: null,
      context: null,
    },
  ];

  return {
    metrics: {
      runId: "run1",
      durationSeconds: 30,
      elapsedMs: 30_000,
      concurrency: 20,
      totalRequests: 600,
      http5xxCount: 0,
      unexpectedHttpCount: 0,
      unexpectedHttpSamples: [],
      activityReads: 40,
      exportCycles: { "hono-drizzle": 15, "prisma-api": 15 },
      latenciesMs: [5, 10, 15, 20, 25, 30, 35, 40, 50, 100],
    },
    expectedMutations: [
      {
        app: "hono-drizzle",
        requestId: "req-h-1",
        kind: "create",
        actor: ALICE,
        actorSource: "comment",
        expectedEvents: [{ source: "db", tableName: "invoice", op: "INSERT", recordId: 10 }],
      },
      {
        app: "hono-drizzle",
        requestId: "req-h-2",
        kind: "finalize",
        actor: AGENT_BOB,
        actorSource: "comment",
        expectedEvents: [
          { source: "db", tableName: "invoice", op: "UPDATE", recordId: 10 },
          { source: "db", tableName: "line_item", op: "INSERT", recordId: 101 },
        ],
      },
      {
        app: "prisma-api",
        requestId: "req-p-1",
        kind: "approve",
        actor: AGENT_BOB,
        actorSource: "set_config",
        expectedEvents: [{ source: "db", tableName: "invoice", op: "UPDATE", recordId: 20 }],
      },
      {
        app: "prisma-api",
        requestId: "req-p-2",
        kind: "event",
        actor: ALICE,
        actorSource: "set_config",
        expectedEvents: [{ source: "app", tableName: null, op: "invoice.exported", recordId: 20 }],
      },
    ],
    abortedRequests: [
      { app: "hono-drizzle", requestId: "req-aborted-1", actor: ALICE, actorSource: "comment" },
    ],
    forbiddenRequests: [
      { app: "hono-drizzle", requestId: "req-rb-1", reason: "rollback" },
      { app: "hono-drizzle", requestId: "req-excl-h1", reason: "excluded-only" },
      { app: "prisma-api", requestId: "req-excl-1", reason: "excluded-only" },
    ],
    directSqlWrites: [
      { app: "hono-drizzle", markerStatus: "direct_sql_run1_1" },
      { app: "prisma-api", markerStatus: "direct_sql_run1_2" },
    ],
    exportedByApp: {
      "hono-drizzle": honoEvents,
      "prisma-api": prismaEvents,
    },
    parseErrorsByApp: { "hono-drizzle": 0, "prisma-api": 0 },
    tamper: { attempts: 12, rejected42501: 12, unexpectedErrors: [] },
    preparedStatements: [
      { app: "hono-drizzle", distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
      { app: "prisma-api", distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
    ],
    verifyResults: [
      { app: "hono-drizzle", ok: true, findingsCount: 0 },
      { app: "prisma-api", ok: true, findingsCount: 0 },
    ],
  };
}

function withExported(
  base: OracleInput,
  app: AppName,
  events: readonly ExportedEvent[],
): OracleInput {
  return {
    ...base,
    exportedByApp: { ...base.exportedByApp, [app]: events },
  };
}

function withPatchedEvent(
  base: OracleInput,
  app: AppName,
  eventId: string,
  patch: Partial<ExportedEvent>,
): OracleInput {
  return withExported(
    base,
    app,
    base.exportedByApp[app].map((ev) => (ev.event_id === eventId ? { ...ev, ...patch } : ev)),
  );
}

function getCheck(input: OracleInput, name: string) {
  const report = evaluateOracle(input);
  const check = report.invariants.find((c) => c.name === name);
  assert.ok(check, `missing invariant ${name}`);
  return { report, check };
}

function runShellArgs(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): { readonly exitCode: number; readonly output: string } {
  try {
    const stdout = execFileSync("bash", [RUN_SH, ...args], {
      cwd: LAB_ROOT,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    const failed = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failed.status === "number" ? failed.status : 1,
      output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    };
  }
}

interface MockServerState {
  nextId: number;
  abortAttempts: number;
  completedDeletes: number;
  seenHumanHeaders: number;
  seenAgentHeaders: number;
  readonly leakActivitySecret: boolean;
  readonly abortDelaysCount: number;
  readonly onDelete: (() => void) | undefined;
}

function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function recordValidatedActorHeaders(req: IncomingMessage, state: MockServerState): void {
  assert.ok(req.headers["x-demo-tenant"], "missing x-demo-tenant");
  assert.ok(req.headers["x-request-id"], "missing x-request-id");
  if (req.headers["x-demo-agent"]) {
    assert.ok(req.headers["x-demo-on-behalf-of"], "missing x-demo-on-behalf-of");
    state.seenAgentHeaders += 1;
  } else {
    assert.ok(req.headers["x-demo-user"], "missing x-demo-user");
    state.seenHumanHeaders += 1;
  }
}

function handleMockInvoiceCreate(
  res: ServerResponse,
  body: Record<string, unknown>,
  state: MockServerState,
): void {
  const id = state.nextId;
  state.nextId += 1;
  if (body.total === "19.99" && state.abortAttempts < state.abortDelaysCount) {
    state.abortAttempts += 1;
    setTimeout(() => {
      if (!res.writableEnded) {
        sendJson(res, 201, { id });
      }
    }, 40);
    return;
  }
  sendJson(res, 201, { id });
}

async function handleMockPost(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  state: MockServerState,
): Promise<void> {
  const raw = await readBodyText(req);
  const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
  if (pathname === "/invoices") {
    handleMockInvoiceCreate(res, body, state);
    return;
  }
  if (pathname.endsWith("/finalize")) {
    if (body.simulateTxRollback === true) {
      sendJson(res, 409, { error: "rolled back" });
      return;
    }
    const lineId = state.nextId;
    state.nextId += 1;
    sendJson(res, 200, { lineItem: { id: lineId } });
    return;
  }
  if (pathname.endsWith("/raw-note")) {
    const lineId = state.nextId;
    state.nextId += 1;
    sendJson(res, 201, { id: lineId });
    return;
  }
  if (pathname.endsWith("/approve")) {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname.endsWith("/events")) {
    sendJson(res, 201, { ok: true });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function handleMockActivity(res: ServerResponse, url: URL, state: MockServerState): void {
  if (!url.searchParams.get("cursor")) {
    sendJson(res, 200, { items: [], nextCursor: "cursor-page-2" });
    return;
  }
  const items = state.leakActivitySecret ? [{ after: { password_hash: "leaked" } }] : [];
  sendJson(res, 200, { items, nextCursor: null });
}

async function startMockLabServer(options: {
  readonly leakActivitySecret?: boolean;
  readonly abortDelaysCount?: number;
  readonly onDelete?: () => void;
}): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
  readonly state: MockServerState;
}> {
  const state: MockServerState = {
    nextId: 100,
    abortAttempts: 0,
    completedDeletes: 0,
    seenHumanHeaders: 0,
    seenAgentHeaders: 0,
    leakActivitySecret: options.leakActivitySecret ?? false,
    abortDelaysCount: options.abortDelaysCount ?? 1,
    onDelete: options.onDelete,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/activity") {
      handleMockActivity(res, url, state);
      return;
    }
    recordValidatedActorHeaders(req, state);
    if (req.method === "POST") {
      void handleMockPost(req, res, url.pathname, state);
      return;
    }
    if (req.method === "PATCH") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE") {
      state.completedDeletes += 1;
      state.onDelete?.();
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, state };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

describe("soak oracle parsing and completeness", () => {
  it("passes baseline zero-event/committed aborts, computes latencies, and escapes Markdown cells", () => {
    const base = makeBaselineInput();
    const baseReport = evaluateOracle(base);
    assert.equal(baseReport.passed, true);
    assert.equal(baseReport.invariants.length, 8);
    assert.equal(baseReport.exportedEvents, 7);

    const withCommittedAbort = withExported(base, "hono-drizzle", [
      ...base.exportedByApp["hono-drizzle"],
      {
        event_id: "evt-abort-ok",
        source: "db",
        table_name: "invoice",
        op: "INSERT",
        record_id: { id: 98 },
        actor: ALICE,
        actor_source: "comment",
        context: { source: "lab/hono-drizzle", requestId: "req-aborted-1" },
      },
    ]);
    const report = evaluateOracle(withCommittedAbort);
    assert.equal(report.passed, true);
    assert.equal(report.exportedEvents, 8);
    assert.equal(report.abortedRequests, 1);
    assert.equal(report.rps, 20);

    const unsorted = Array.from({ length: 100 }, (_, i) => 100 - i + 0.126);
    const snapshot = [...unsorted];
    assert.deepEqual(computeLatencies(unsorted), { p50: 50.13, p95: 95.13, p99: 99.13 });
    assert.deepEqual(unsorted, snapshot);
    assert.deepEqual(computeLatencies([42.567]), { p50: 42.57, p95: 42.57, p99: 42.57 });
    assert.deepEqual(computeLatencies([]), { p50: 0, p95: 0, p99: 0 });

    const fastReport = evaluateOracle({
      ...base,
      metrics: { ...base.metrics, elapsedMs: 0, totalRequests: 10 },
    });
    assert.equal(Number.isFinite(fastReport.rps), true);
    assert.equal(fastReport.rps, 10_000);

    const mdPass = formatMarkdownReport(report);
    assert.match(mdPass, /# Auditstream Lab Soak Report — PASS/);
    assert.match(mdPass, /\| `committed_mutations_exported` \| \*\*PASS\*\* \|/);

    const failedReport = evaluateOracle({
      ...base,
      tamper: { attempts: 1, rejected42501: 0, unexpectedErrors: ["a\r\nb\rc\nd\\|pipe"] },
    });
    const mdFail = formatMarkdownReport(failedReport);
    assert.match(mdFail, /# Auditstream Lab Soak Report — FAIL/);
    assert.match(mdFail, /a b c d\\\\\\\|pipe/);
  });

  it("parses JSONL strictly and flags malformed, missing, empty, or duplicate event_ids", () => {
    const parsed = parseJsonlContent(
      '{"event_id":"e1","op":"INSERT"}\r\n   \r\nnull\n[1,2]\n"str"\n{bad\n',
    );
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0]?.event_id, "e1");
    assert.equal(parsed.events[0]?.op, "INSERT");
    assert.equal(parsed.parseErrors, 4);

    const base = makeBaselineInput();
    assert.equal(
      getCheck(
        { ...base, parseErrorsByApp: { "hono-drizzle": 1, "prisma-api": 0 } },
        "export_jsonl_integrity",
      ).check.passed,
      false,
    );

    for (const badEv of [
      { source: "db", table_name: "invoice", op: "INSERT" },
      { event_id: "", source: "db", table_name: "invoice", op: "INSERT" },
    ]) {
      const bad = withExported(base, "hono-drizzle", [
        ...base.exportedByApp["hono-drizzle"],
        badEv,
      ]);
      const res = getCheck(bad, "export_jsonl_integrity");
      assert.equal(res.check.passed, false);
      assert.match(res.check.detail, /missing_event_id=1/);
    }

    const first = base.exportedByApp["hono-drizzle"][0];
    assert.ok(first);
    const dup = withExported(base, "hono-drizzle", [...base.exportedByApp["hono-drizzle"], first]);
    const dupRes = getCheck(dup, "export_jsonl_integrity");
    assert.equal(dupRes.check.passed, false);
    assert.match(dupRes.check.detail, /duplicate_event_id=1/);
  });

  it("checks exact event field matching, partial loss, per-app coverage, and extra leaked events", () => {
    const base = makeBaselineInput();

    for (const patch of [
      { source: "app" },
      { table_name: "line_item" },
      { op: "DELETE" },
      { record_id: { id: 999 } },
    ]) {
      const res = getCheck(
        withPatchedEvent(base, "hono-drizzle", "evt-h1", patch),
        "committed_mutations_exported",
      );
      assert.equal(res.check.passed, false);
      assert.match(res.check.detail, /missing=1/);
    }

    const partialLoss = withExported(
      base,
      "hono-drizzle",
      base.exportedByApp["hono-drizzle"].filter((ev) => ev.event_id !== "evt-h3"),
    );
    assert.equal(getCheck(partialLoss, "committed_mutations_exported").check.passed, false);

    const missingPrisma = {
      ...base,
      expectedMutations: base.expectedMutations.filter((m) => m.app !== "prisma-api"),
    };
    const missingPrismaRes = getCheck(missingPrisma, "committed_mutations_exported");
    assert.equal(missingPrismaRes.check.passed, false);
    assert.match(missingPrismaRes.check.detail, /zero mutations for prisma-api/);

    const extraUnderValidReq = withExported(base, "prisma-api", [
      ...base.exportedByApp["prisma-api"],
      {
        event_id: "evt-p-leaked-noop",
        source: "db",
        table_name: "invoice",
        op: "UPDATE",
        record_id: { id: 20 },
        actor: AGENT_BOB,
        actor_source: "set_config",
        context: { source: "lab/prisma-api", requestId: "req-p-1" },
      },
    ]);
    const extraRes = getCheck(extraUnderValidReq, "committed_mutations_exported");
    assert.equal(extraRes.check.passed, false);
    assert.match(extraRes.check.detail, /extra=1/);
  });
});

describe("soak oracle attribution and leak invariants", () => {
  it("detects rollback leaks, excluded-only leaks, per-app excluded coverage, password_hash, and markers", () => {
    const base = makeBaselineInput();

    const rb = withExported(base, "hono-drizzle", [
      ...base.exportedByApp["hono-drizzle"],
      {
        event_id: "evt-rb",
        source: "db",
        table_name: "invoice",
        op: "UPDATE",
        context: { requestId: "req-rb-1" },
      },
    ]);
    assert.equal(getCheck(rb, "zero_rollbacks_and_excluded_noops").check.passed, false);

    const excl = withExported(base, "prisma-api", [
      ...base.exportedByApp["prisma-api"],
      {
        event_id: "evt-excl",
        source: "db",
        table_name: "invoice",
        op: "UPDATE",
        context: { requestId: "req-excl-1" },
      },
    ]);
    assert.equal(getCheck(excl, "zero_rollbacks_and_excluded_noops").check.passed, false);

    for (const payload of [
      { before: { password_hash: "abc" } },
      { after: { password_hash: "abc" } },
      { changed: ["password_hash"] },
    ]) {
      const leak = withExported(base, "prisma-api", [
        ...base.exportedByApp["prisma-api"],
        { event_id: "evt-ph", source: "db", table_name: "invoice", op: "UPDATE", ...payload },
      ]);
      assert.equal(getCheck(leak, "zero_rollbacks_and_excluded_noops").check.passed, false);
    }

    for (const marker of [
      "Rolled back savepoint adjustment",
      "Should roll back",
      "secret-soak-123",
    ]) {
      const leak = withExported(base, "hono-drizzle", [
        ...base.exportedByApp["hono-drizzle"],
        {
          event_id: "evt-mk",
          source: "db",
          table_name: "line_item",
          op: "INSERT",
          after: { description: marker },
        },
      ]);
      assert.equal(getCheck(leak, "zero_rollbacks_and_excluded_noops").check.passed, false);
    }

    assert.equal(
      getCheck(
        {
          ...base,
          forbiddenRequests: base.forbiddenRequests.filter((r) => r.reason !== "rollback"),
        },
        "zero_rollbacks_and_excluded_noops",
      ).check.passed,
      false,
    );
    const missingHonoExcl = getCheck(
      {
        ...base,
        forbiddenRequests: base.forbiddenRequests.filter(
          (r) => !(r.app === "hono-drizzle" && r.reason === "excluded-only"),
        ),
      },
      "zero_rollbacks_and_excluded_noops",
    );
    assert.equal(missingHonoExcl.check.passed, false);
    assert.match(missingHonoExcl.check.detail, /excluded-only\(hono-drizzle\)/);
  });

  it("detects actor mismatches, invalid_actor_source, unaccounted events, and aborted request attribution", () => {
    const base = makeBaselineInput();

    for (const badActor of [
      null,
      { ...ALICE, type: "ai_agent" },
      { ...ALICE, id: "user_99" },
      { ...ALICE, tenant: "tenant_2" },
      { ...ALICE, onBehalfOf: { type: "user", id: "user_7" } },
      { ...ALICE, onBehalfOf: "unexpected_string" },
    ]) {
      const res = getCheck(
        withPatchedEvent(base, "hono-drizzle", "evt-h1", { actor: badActor }),
        "zero_actor_attribution_leaks",
      );
      assert.equal(res.check.passed, false);
      assert.match(res.check.detail, /mismatches=1/);
    }

    for (const badAgent of [
      { type: "ai_agent", id: "agent_2", tenant: "tenant_1" },
      { ...AGENT_BOB, onBehalfOf: { type: "user", id: "user_99" } },
      { ...AGENT_BOB, onBehalfOf: { type: "ai_agent", id: "user_7" } },
    ]) {
      const res = getCheck(
        withPatchedEvent(base, "hono-drizzle", "evt-h2", { actor: badAgent }),
        "zero_actor_attribution_leaks",
      );
      assert.equal(res.check.passed, false);
      assert.match(res.check.detail, /mismatches=1/);
    }

    const wrongSource = getCheck(
      withPatchedEvent(base, "prisma-api", "evt-p1", { actor_source: "comment" }),
      "zero_actor_attribution_leaks",
    );
    assert.equal(wrongSource.check.passed, false);
    assert.match(wrongSource.check.detail, /mismatches=1/);

    const invalidSource = getCheck(
      withPatchedEvent(base, "prisma-api", "evt-p1", { actor_source: "invalid" }),
      "zero_actor_attribution_leaks",
    );
    assert.equal(invalidSource.check.passed, false);
    assert.match(invalidSource.check.detail, /invalid_actor_source@prisma-api/);

    const unaccounted = getCheck(
      withExported(base, "prisma-api", [
        ...base.exportedByApp["prisma-api"],
        {
          event_id: "evt-stray",
          source: "db",
          table_name: "invoice",
          op: "INSERT",
          record_id: { id: 99 },
          actor: ALICE,
          actor_source: "comment",
          context: { requestId: "req-unknown" },
        },
      ]),
      "zero_actor_attribution_leaks",
    );
    assert.equal(unaccounted.check.passed, false);
    assert.match(unaccounted.check.detail, /unaccounted_event:prisma-api\/req-unknown/);

    for (const patch of [{ actor: AGENT_BOB }, { actor_source: "set_config" }]) {
      const res = getCheck(
        withExported(base, "hono-drizzle", [
          ...base.exportedByApp["hono-drizzle"],
          {
            event_id: "evt-abort-bad",
            source: "db",
            table_name: "invoice",
            op: "INSERT",
            record_id: { id: 99 },
            actor: ALICE,
            actor_source: "comment",
            context: { requestId: "req-aborted-1" },
            ...patch,
          },
        ]),
        "zero_actor_attribution_leaks",
      );
      assert.equal(res.check.passed, false);
      assert.match(res.check.detail, /mismatches=1/);
    }
  });
});

describe("soak oracle direct-SQL and infrastructure invariants", () => {
  it("detects direct-SQL loss, duplicates, wrong op/source, bleed, and per-app coverage floors", () => {
    const base = makeBaselineInput();

    const partialDirectLoss = getCheck(
      {
        ...base,
        directSqlWrites: [
          ...base.directSqlWrites,
          { app: "hono-drizzle", markerStatus: "direct_sql_run1_missing" },
        ],
      },
      "zero_actor_attribution_leaks",
    );
    assert.equal(partialDirectLoss.check.passed, false);
    assert.match(
      partialDirectLoss.check.detail,
      /missing_direct_sql:hono-drizzle\/direct_sql_run1_missing/,
    );

    const dupDirect = getCheck(
      withExported(base, "hono-drizzle", [
        ...base.exportedByApp["hono-drizzle"],
        {
          event_id: "evt-h4-dup",
          source: "db",
          table_name: "invoice",
          op: "INSERT",
          record_id: { id: 12 },
          after: { id: 12, status: "direct_sql_run1_1", total: "1.00" },
          actor: null,
          actor_source: null,
          context: null,
        },
      ]),
      "zero_actor_attribution_leaks",
    );
    assert.equal(dupDirect.check.passed, false);
    assert.match(dupDirect.check.detail, /duplicate_direct_sql:hono-drizzle\/direct_sql_run1_1/);

    for (const wrongDirect of [{ op: "UPDATE" }, { source: "app" }]) {
      const res = getCheck(
        withPatchedEvent(base, "hono-drizzle", "evt-h4", wrongDirect),
        "zero_actor_attribution_leaks",
      );
      assert.equal(res.check.passed, false);
      assert.match(res.check.detail, /missing_direct_sql:hono-drizzle\/direct_sql_run1_1/);
    }

    for (const bleedPatch of [
      { actor: ALICE },
      { actor_source: "set_config" },
      { context: { requestId: "leaked" } },
    ]) {
      const res = getCheck(
        withPatchedEvent(base, "hono-drizzle", "evt-h4", bleedPatch),
        "zero_actor_attribution_leaks",
      );
      assert.equal(res.check.passed, false);
      assert.match(res.check.detail, /direct_sql_bleed=1/);
    }

    const noPrismaDirect = getCheck(
      {
        ...base,
        directSqlWrites: base.directSqlWrites.filter((d) => d.app !== "prisma-api"),
        exportedByApp: {
          ...base.exportedByApp,
          "prisma-api": base.exportedByApp["prisma-api"].filter((ev) => ev.event_id !== "evt-p3"),
        },
      },
      "zero_actor_attribution_leaks",
    );
    assert.equal(noPrismaDirect.check.passed, false);
    assert.match(noPrismaDirect.check.detail, /missing coverage: http=, direct=prisma-api\)/);

    const noPrismaHttp = getCheck(
      {
        ...base,
        expectedMutations: base.expectedMutations.filter((m) => m.app !== "prisma-api"),
        exportedByApp: {
          ...base.exportedByApp,
          "prisma-api": base.exportedByApp["prisma-api"].filter((ev) => ev.event_id === "evt-p3"),
        },
      },
      "zero_actor_attribution_leaks",
    );
    assert.equal(noPrismaHttp.check.passed, false);
    assert.match(noPrismaHttp.check.detail, /missing coverage: http=prisma-api/);
  });

  it("checks prepared statements, tamper protection, verify, and HTTP 5xx/unexpected errors", () => {
    const base = makeBaselineInput();

    for (const preparedStatements of [
      [
        { app: "hono-drizzle" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 1 },
        { app: "prisma-api" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
      ],
      [
        { app: "hono-drizzle" as const, distinctBackends: 5, expectedBackends: 6, leakedCount: 0 },
        { app: "prisma-api" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
      ],
      [{ app: "hono-drizzle" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 }],
      [
        { app: "hono-drizzle" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
        { app: "hono-drizzle" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
      ],
      [
        { app: "hono-drizzle" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
        { app: "prisma-api" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
        { app: "hono-drizzle" as const, distinctBackends: 6, expectedBackends: 6, leakedCount: 0 },
      ],
    ]) {
      assert.equal(
        getCheck({ ...base, preparedStatements }, "zero_prepared_statement_leaks").check.passed,
        false,
      );
    }

    for (const tamper of [
      { attempts: 12, rejected42501: 11, unexpectedErrors: [] },
      { attempts: 12, rejected42501: 12, unexpectedErrors: ["err"] },
      { attempts: 0, rejected42501: 0, unexpectedErrors: [] },
    ]) {
      assert.equal(getCheck({ ...base, tamper }, "tamper_protection_42501").check.passed, false);
    }

    for (const verifyResults of [
      [
        { app: "hono-drizzle" as const, ok: true, findingsCount: 0 },
        { app: "prisma-api" as const, ok: false, findingsCount: 0 },
      ],
      [
        { app: "hono-drizzle" as const, ok: true, findingsCount: 0 },
        { app: "prisma-api" as const, ok: true, findingsCount: 1 },
      ],
      [{ app: "hono-drizzle" as const, ok: true, findingsCount: 0 }],
      [
        { app: "hono-drizzle" as const, ok: true, findingsCount: 0 },
        { app: "hono-drizzle" as const, ok: true, findingsCount: 0 },
      ],
      [
        { app: "hono-drizzle" as const, ok: true, findingsCount: 0 },
        { app: "prisma-api" as const, ok: true, findingsCount: 0 },
        { app: "hono-drizzle" as const, ok: true, findingsCount: 0 },
      ],
    ]) {
      assert.equal(
        getCheck({ ...base, verifyResults }, "final_auditstream_verify").check.passed,
        false,
      );
    }

    assert.equal(
      getCheck({ ...base, metrics: { ...base.metrics, http5xxCount: 1 } }, "zero_http_5xx_errors")
        .check.passed,
      false,
    );
    assert.equal(
      getCheck(
        {
          ...base,
          metrics: {
            ...base.metrics,
            unexpectedHttpCount: 1,
            unexpectedHttpSamples: ["prisma/404"],
          },
        },
        "zero_http_5xx_errors",
      ).check.passed,
      false,
    );
    assert.equal(
      getCheck({ ...base, metrics: { ...base.metrics, totalRequests: 0 } }, "zero_http_5xx_errors")
        .check.passed,
      false,
    );
  });
});

describe("soak workload generator", () => {
  it("distributes actors across all 35 humans, 10 agents, and 5 tenants", () => {
    const humans = new Set<string>();
    const agents = new Set<string>();
    const tenants = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const h = pickActor(i, false);
      assert.equal(h.type, "user");
      assert.equal(h.onBehalfOf, undefined);
      humans.add(h.id);
      tenants.add(h.tenant);

      const a = pickActor(i, true);
      assert.equal(a.type, "ai_agent");
      assert.equal(a.onBehalfOf?.type, "user");
      assert.ok(a.onBehalfOf?.id.startsWith("user_"));
      agents.add(a.id);
    }
    assert.equal(humans.size, 35);
    assert.equal(agents.size, 10);
    assert.equal(tenants.size, 5);
  });

  it("runs concurrent HTTP cycles, checks headers/secret leaks/aborts, and aborts siblings on fatal error", async () => {
    const stopController = new AbortController();
    let honoDeletes = 0;
    let prismaDeletes = 0;
    const maybeStop = (): void => {
      if (honoDeletes >= 6 && prismaDeletes >= 6) {
        stopController.abort();
      }
    };

    const hono = await startMockLabServer({
      leakActivitySecret: true,
      abortDelaysCount: 1,
      onDelete: () => {
        honoDeletes += 1;
        maybeStop();
      },
    });
    const prisma = await startMockLabServer({
      leakActivitySecret: false,
      abortDelaysCount: 1,
      onDelete: () => {
        prismaDeletes += 1;
        maybeStop();
      },
    });

    try {
      const recorder = createWorkloadRecorder();
      await runConcurrentWorkers({
        runId: "unit1",
        honoBaseUrl: hono.baseUrl,
        prismaBaseUrl: prisma.baseUrl,
        concurrency: 2,
        durationSeconds: 10,
        recorder,
        signal: stopController.signal,
      });

      assert.ok(hono.state.seenHumanHeaders > 0 && hono.state.seenAgentHeaders > 0);
      assert.ok(prisma.state.seenHumanHeaders > 0 && prisma.state.seenAgentHeaders > 0);
      assert.equal(recorder.http5xxCount, 0);
      assert.ok(recorder.abortedRequests.length >= 2);
      assert.ok(recorder.activityReads >= 4);
      assert.ok(recorder.unexpectedHttpCount >= 1);
      assert.ok(
        recorder.unexpectedHttpSamples.some((s) =>
          s.includes("hono-drizzle/activity leaked excluded secret"),
        ),
      );

      const honoDelete = recorder.expectedMutations.find(
        (m) => m.app === "hono-drizzle" && m.kind === "delete",
      );
      assert.equal(honoDelete?.expectedEvents.length, 3);
      assert.ok(
        recorder.expectedMutations.some(
          (m) => m.app === "prisma-api" && m.kind === "approve" && m.actorSource === "set_config",
        ),
      );
      assert.ok(
        recorder.forbiddenRequests.some((r) => r.app === "hono-drizzle" && r.reason === "rollback"),
      );
      assert.ok(
        recorder.forbiddenRequests.some(
          (r) => r.app === "hono-drizzle" && r.reason === "excluded-only",
        ),
      );
      assert.ok(
        recorder.forbiddenRequests.some(
          (r) => r.app === "prisma-api" && r.reason === "excluded-only",
        ),
      );
    } finally {
      await closeServer(hono.server);
      await closeServer(prisma.server);
    }

    // Fatal socket drop on one app must abort a stalled sibling worker promptly and reject.
    const failing = createServer((req) => {
      req.socket.destroy();
    });
    const stalled = createServer((_req, _res) => {
      // Intentionally keep connection open until sibling aborts.
    });
    await new Promise<void>((r) => failing.listen(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", () => r()));
    try {
      const start = Date.now();
      await assert.rejects(
        runConcurrentWorkers({
          runId: "unit2",
          honoBaseUrl: `http://127.0.0.1:${(failing.address() as AddressInfo).port}`,
          prismaBaseUrl: `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`,
          concurrency: 2,
          durationSeconds: 30,
          recorder: createWorkloadRecorder(),
        }),
      );
      assert.ok(Date.now() - start < 3_000, "fatal error did not abort sibling worker promptly");
    } finally {
      await closeServer(failing);
      await closeServer(stalled);
    }
  });
});

describe("soak/run.sh CLI validation", () => {
  it("validates flags, integer bounds, directory rejection, dash-prefixed paths, and symlink collisions", () => {
    const helpRes = runShellArgs(["--help"], { APP_USER_PASSWORD: 'invalid"pw' });
    assert.equal(helpRes.exitCode, 0);
    assert.match(helpRes.output, /Usage: \.\/soak\/run\.sh/);

    const cases: Array<[readonly string[], RegExp]> = [
      [["--duration"], /--duration requires a non-empty value/],
      [["--duration", "08"], /--duration must be a base-10 integer between 1 and 2147483/],
      [["--duration", "2147484"], /--duration must be a base-10 integer between 1 and 2147483/],
      [
        ["--duration", "20000000000000000000"],
        /--duration must be a base-10 integer between 1 and 2147483/,
      ],
      [["--concurrency", "1"], /--concurrency must be a base-10 integer between 2 and 10000/],
      [["--concurrency", "10001"], /--concurrency must be a base-10 integer between 2 and 10000/],
      [
        ["--export-interval", "0"],
        /--export-interval must be a base-10 integer between 1 and 2147483/,
      ],
      [
        ["--export-interval", "2147484"],
        /--export-interval must be a base-10 integer between 1 and 2147483/,
      ],
      [["--out", ""], /--out requires a non-empty value/],
      [["--out", "/tmp"], /--out points to an existing directory/],
      [["--out", "/tmp/reports/"], /--out must be a file path, not a directory/],
      [["--out", "."], /--out must be a file path, not a directory/],
      [["--json-out", ".tmp/soak/soak-report.md"], /must resolve to distinct file paths/],
      [
        ["--out", "./foo.md", "--json-out", resolve(LAB_ROOT, "foo.md")],
        /must resolve to distinct file paths/,
      ],
      [["--out", "-foo.md", "--json-out", "-foo.md"], /must resolve to distinct file paths/],
      [["--bogus"], /unknown argument '--bogus'/],
    ];
    for (const [args, pattern] of cases) {
      const res = runShellArgs(args, { APP_USER_PASSWORD: 'invalid"pw' });
      assert.equal(
        res.exitCode,
        2,
        `expected exit 2 for ${args.join(" ")}, got ${res.exitCode}: ${res.output}`,
      );
      assert.match(res.output, pattern);
    }

    const evalFlagPath = '--eval=console.error("EVAL"+"_RAN");process.exit(42)';
    const evalRes = runShellArgs(["--out", evalFlagPath, "--json-out", evalFlagPath], {
      APP_USER_PASSWORD: 'invalid"pw',
    });
    assert.equal(evalRes.exitCode, 2, evalRes.output);
    assert.match(evalRes.output, /must resolve to distinct file paths/);
    assert.equal(evalRes.output.includes("EVAL_RAN"), false);

    const tmpDir = mkdtempSync(join(tmpdir(), "auditstream-lab-soak-test-"));
    try {
      const realSub = join(tmpDir, "real", "sub");
      mkdirSync(realSub, { recursive: true });
      const aliasDir = join(tmpDir, "alias");
      symlinkSync(realSub, aliasDir);
      const realTarget = join(tmpDir, "real", "target.md");
      symlinkSync("../target.md", join(realSub, "dangling.md"));

      for (const pair of [
        [join(realSub, "report.md"), join(aliasDir, "report.md")],
        [join(aliasDir, "dangling.md"), realTarget],
        [`${aliasDir}/../report.md`, join(tmpDir, "real", "report.md")],
      ]) {
        const res = runShellArgs(["--out", pair[0] ?? "", "--json-out", pair[1] ?? ""], {
          APP_USER_PASSWORD: 'invalid"pw',
        });
        assert.equal(res.exitCode, 2, res.output);
        assert.match(res.output, /must resolve to distinct file paths/);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
