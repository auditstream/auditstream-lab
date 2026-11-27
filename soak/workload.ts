/**
 * Concurrent HTTP workload generator for `hono-drizzle` and `prisma-api` during soak runs.
 *
 * Mixes 35 distinct human actors, 10 delegated AI agents (`onBehalfOf`), CRUD, excluded-only
 * `passwordHash` updates, Drizzle nested `SAVEPOINT` + full `ROLLBACK`, raw SQL, Prisma
 * `auditTransaction()`, `audit.log()`, keyset-paginated `GET /activity`, and mid-flight
 * `AbortController` cancellations.
 */

import { performance } from "node:perf_hooks";
import type {
  AbortedRequestRecord,
  ActorSpec,
  AppName,
  ExpectedEventSpec,
  ExpectedMutation,
  ForbiddenRequestRecord,
} from "./types.ts";

const HUMAN_ACTORS = 35;
const AGENT_ACTORS = 10;
const TENANTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export interface WorkloadRecorder {
  totalRequests: number;
  http5xxCount: number;
  unexpectedHttpCount: number;
  readonly unexpectedHttpSamples: string[];
  activityReads: number;
  readonly latenciesMs: number[];
  readonly expectedMutations: ExpectedMutation[];
  readonly abortedRequests: AbortedRequestRecord[];
  readonly forbiddenRequests: ForbiddenRequestRecord[];
}

export function createWorkloadRecorder(): WorkloadRecorder {
  return {
    totalRequests: 0,
    http5xxCount: 0,
    unexpectedHttpCount: 0,
    unexpectedHttpSamples: [],
    activityReads: 0,
    latenciesMs: [],
    expectedMutations: [],
    abortedRequests: [],
    forbiddenRequests: [],
  };
}

function recordUnexpectedHttp(recorder: WorkloadRecorder, detail: string): void {
  recorder.unexpectedHttpCount += 1;
  if (recorder.unexpectedHttpSamples.length < 10) {
    recorder.unexpectedHttpSamples.push(detail);
  }
}

export function pickActor(seed: number, delegated: boolean): ActorSpec {
  const userNum = (seed % HUMAN_ACTORS) + 1;
  const tenant = `tenant_${(seed % TENANTS) + 1}`;
  if (!delegated) {
    return { type: "user", id: `user_${userNum}`, tenant };
  }
  const agentNum = (seed % AGENT_ACTORS) + 1;
  return {
    type: "ai_agent",
    id: `agent_${agentNum}`,
    tenant,
    onBehalfOf: { type: "user", id: `user_${userNum}` },
  };
}

function buildActorHeaders(actor: ActorSpec, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-demo-tenant": actor.tenant,
    "x-request-id": requestId,
  };
  if (actor.type === "ai_agent") {
    headers["x-demo-agent"] = actor.id;
    if (actor.onBehalfOf) {
      headers["x-demo-on-behalf-of"] = actor.onBehalfOf.id;
    }
  } else {
    headers["x-demo-user"] = actor.id;
  }
  return headers;
}

interface HttpResult {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown> | null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function composeRequestSignal(
  hardSignal: AbortSignal | undefined,
  customSignal?: AbortSignal,
): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (hardSignal) {
    signals.push(hardSignal);
  }
  if (customSignal) {
    signals.push(customSignal);
  }
  return AbortSignal.any(signals);
}

async function sendRequest(
  recorder: WorkloadRecorder,
  url: string,
  init: RequestInit,
  hardSignal?: AbortSignal,
): Promise<HttpResult> {
  const start = performance.now();
  const signal = composeRequestSignal(hardSignal, init.signal ?? undefined);
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  const elapsed = performance.now() - start;

  recorder.totalRequests += 1;
  recorder.latenciesMs.push(elapsed);
  if (response.status >= 500) {
    recorder.http5xxCount += 1;
  }

  let json: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      json = null;
    }
  }
  return { status: response.status, text, json };
}

function readNumericId(record: Record<string, unknown> | null, key = "id"): number | null {
  const val = record?.[key];
  return typeof val === "number" && Number.isInteger(val) ? val : null;
}

function checkActivityBodySafe(recorder: WorkloadRecorder, app: AppName, text: string): void {
  if (text.includes("password_hash") || text.includes("secret-soak-")) {
    recordUnexpectedHttp(recorder, `${app}/activity leaked excluded secret`);
  }
}

interface WorkerContext {
  readonly runId: string;
  readonly app: AppName;
  readonly baseUrl: string;
  readonly workerId: number;
  readonly recorder: WorkloadRecorder;
  readonly signal: AbortSignal;
  nextSeq(): number;
}

function nextReqId(ctx: WorkerContext): string {
  const prefix = ctx.app === "hono-drizzle" ? "hd" : "pr";
  return `s-${ctx.runId}-${prefix}-${ctx.nextSeq()}`;
}

async function runMidFlightAbort(ctx: WorkerContext, seed: number): Promise<void> {
  const actor = pickActor(seed, seed % 2 === 0);
  const requestId = nextReqId(ctx);
  const controller = new AbortController();
  const abortAfterMs = (seed % 5) + 1;
  const timer = setTimeout(() => controller.abort(), abortAfterMs);

  try {
    const res = await sendRequest(
      ctx.recorder,
      `${ctx.baseUrl}/invoices`,
      {
        method: "POST",
        headers: buildActorHeaders(actor, requestId),
        body: JSON.stringify({
          status: "draft",
          total: "19.99",
          passwordHash: `secret-soak-${requestId}`,
        }),
        signal: controller.signal,
      },
      ctx.signal,
    );
    const createdId = readNumericId(res.json);
    if (res.status === 201 && createdId !== null) {
      ctx.recorder.expectedMutations.push({
        app: ctx.app,
        requestId,
        kind: "create",
        actor,
        actorSource: "comment",
        expectedEvents: [{ source: "db", tableName: "invoice", op: "INSERT", recordId: createdId }],
      });
    } else {
      recordUnexpectedHttp(ctx.recorder, `${ctx.app}/abort-create status=${res.status}`);
    }
  } catch (err) {
    if (isAbortError(err)) {
      if (ctx.signal.aborted) {
        return;
      }
      ctx.recorder.abortedRequests.push({
        app: ctx.app,
        requestId,
        actor,
        actorSource: "comment",
      });
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function runActivityPagination(ctx: WorkerContext): Promise<void> {
  const page1 = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/activity?limit=5`,
    { method: "GET" },
    ctx.signal,
  );
  ctx.recorder.activityReads += 1;
  if (page1.status !== 200) {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/activity page1 status=${page1.status}`);
    return;
  }
  checkActivityBodySafe(ctx.recorder, ctx.app, page1.text);

  const cursor = typeof page1.json?.nextCursor === "string" ? page1.json.nextCursor : null;
  if (!cursor || ctx.signal.aborted) {
    return;
  }
  const page2 = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/activity?limit=5&cursor=${encodeURIComponent(cursor)}`,
    { method: "GET" },
    ctx.signal,
  );
  ctx.recorder.activityReads += 1;
  if (page2.status !== 200) {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/activity page2 status=${page2.status}`);
    return;
  }
  checkActivityBodySafe(ctx.recorder, ctx.app, page2.text);
}

async function runDrizzleSpecificSteps(
  ctx: WorkerContext,
  invoiceId: number,
  seed: number,
): Promise<number[]> {
  const lineItemIds: number[] = [];
  const agent = pickActor(seed + 1, true);
  const finalizeReqId = nextReqId(ctx);
  const finalized = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}/finalize`,
    {
      method: "POST",
      headers: buildActorHeaders(agent, finalizeReqId),
      body: JSON.stringify({
        amount: "125.50",
        description: `Soak finalize ${finalizeReqId}`,
        simulateSavepointRollback: true,
      }),
    },
    ctx.signal,
  );
  const lineItemObj =
    typeof finalized.json?.lineItem === "object" && finalized.json.lineItem !== null
      ? (finalized.json.lineItem as Record<string, unknown>)
      : null;
  const lineItemId = readNumericId(lineItemObj);
  if (finalized.status === 200 && lineItemId !== null) {
    lineItemIds.push(lineItemId);
    ctx.recorder.expectedMutations.push({
      app: ctx.app,
      requestId: finalizeReqId,
      kind: "finalize",
      actor: agent,
      actorSource: "comment",
      expectedEvents: [
        { source: "db", tableName: "invoice", op: "UPDATE", recordId: invoiceId },
        { source: "db", tableName: "line_item", op: "INSERT", recordId: lineItemId },
      ],
    });
  } else {
    recordUnexpectedHttp(
      ctx.recorder,
      `${ctx.app}/finalize status=${finalized.status} lineItemId=${String(lineItemId)}`,
    );
  }
  if (ctx.signal.aborted) {
    return lineItemIds;
  }

  // Full transaction rollback (must return 409 and leave 0 audit rows).
  const rollbackReqId = nextReqId(ctx);
  ctx.recorder.forbiddenRequests.push({
    app: ctx.app,
    requestId: rollbackReqId,
    reason: "rollback",
  });
  const rb = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}/finalize`,
    {
      method: "POST",
      headers: buildActorHeaders(agent, rollbackReqId),
      body: JSON.stringify({
        amount: "999.99",
        description: "Should roll back",
        simulateTxRollback: true,
      }),
    },
    ctx.signal,
  );
  if (rb.status !== 409) {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/rollback status=${rb.status}`);
  }
  if (ctx.signal.aborted) {
    return lineItemIds;
  }

  // Direct pool.query raw SQL note outside Drizzle's query builder.
  const human = pickActor(seed + 2, false);
  const rawReqId = nextReqId(ctx);
  const raw = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}/raw-note`,
    {
      method: "POST",
      headers: buildActorHeaders(human, rawReqId),
      body: JSON.stringify({ description: `Raw note ${rawReqId}`, amount: "12.25" }),
    },
    ctx.signal,
  );
  const rawId = readNumericId(raw.json);
  if (raw.status === 201 && rawId !== null) {
    lineItemIds.push(rawId);
    ctx.recorder.expectedMutations.push({
      app: ctx.app,
      requestId: rawReqId,
      kind: "raw-note",
      actor: human,
      actorSource: "comment",
      expectedEvents: [{ source: "db", tableName: "line_item", op: "INSERT", recordId: rawId }],
    });
  } else {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/raw-note status=${raw.status}`);
  }

  return lineItemIds;
}

async function runPrismaSpecificSteps(
  ctx: WorkerContext,
  invoiceId: number,
  seed: number,
): Promise<number[]> {
  const agent = pickActor(seed + 1, true);
  const approveReqId = nextReqId(ctx);
  const approved = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}/approve`,
    {
      method: "POST",
      headers: buildActorHeaders(agent, approveReqId),
      body: JSON.stringify({ status: "approved" }),
    },
    ctx.signal,
  );
  if (approved.status === 200) {
    ctx.recorder.expectedMutations.push({
      app: ctx.app,
      requestId: approveReqId,
      kind: "approve",
      actor: agent,
      actorSource: "set_config",
      expectedEvents: [{ source: "db", tableName: "invoice", op: "UPDATE", recordId: invoiceId }],
    });
  } else {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/approve status=${approved.status}`);
  }
  return [];
}

async function createAndPatchInvoice(
  ctx: WorkerContext,
  cycle: number,
  seed: number,
): Promise<number | null> {
  const human = pickActor(seed, false);
  const createReqId = nextReqId(ctx);
  const created = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices`,
    {
      method: "POST",
      headers: buildActorHeaders(human, createReqId),
      body: JSON.stringify({
        status: "draft",
        total: "50.00",
        passwordHash: `secret-soak-init-${createReqId}`,
      }),
    },
    ctx.signal,
  );
  const invoiceId = readNumericId(created.json);
  if (created.status !== 201 || invoiceId === null) {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/create status=${created.status}`);
    return null;
  }
  ctx.recorder.expectedMutations.push({
    app: ctx.app,
    requestId: createReqId,
    kind: "create",
    actor: human,
    actorSource: "comment",
    expectedEvents: [{ source: "db", tableName: "invoice", op: "INSERT", recordId: invoiceId }],
  });

  // Excluded-only column update (rotation or null-clear; must emit 0 audit rows).
  const exclReqId = nextReqId(ctx);
  ctx.recorder.forbiddenRequests.push({
    app: ctx.app,
    requestId: exclReqId,
    reason: "excluded-only",
  });
  const exclBody =
    cycle % 2 === 0 ? { passwordHash: `secret-soak-rot-${exclReqId}` } : { passwordHash: null };
  const excl = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}`,
    {
      method: "PATCH",
      headers: buildActorHeaders(human, exclReqId),
      body: JSON.stringify(exclBody),
    },
    ctx.signal,
  );
  if (excl.status !== 200) {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/excluded-patch status=${excl.status}`);
  }

  // Regular PATCH updating total + status.
  const patchActor = pickActor(seed + 3, cycle % 2 === 1);
  const patchReqId = nextReqId(ctx);
  const patched = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}`,
    {
      method: "PATCH",
      headers: buildActorHeaders(patchActor, patchReqId),
      body: JSON.stringify({ status: "review", total: "75.25" }),
    },
    ctx.signal,
  );
  if (patched.status === 200) {
    ctx.recorder.expectedMutations.push({
      app: ctx.app,
      requestId: patchReqId,
      kind: "patch",
      actor: patchActor,
      actorSource: "comment",
      expectedEvents: [{ source: "db", tableName: "invoice", op: "UPDATE", recordId: invoiceId }],
    });
  } else {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/patch status=${patched.status}`);
  }
  return invoiceId;
}

async function logAndDeleteInvoice(
  ctx: WorkerContext,
  invoiceId: number,
  lineItemIds: readonly number[],
  cycle: number,
  seed: number,
): Promise<void> {
  const eventActor = pickActor(seed + 5, cycle % 3 === 0);
  const eventReqId = nextReqId(ctx);
  const logged = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}/events`,
    {
      method: "POST",
      headers: buildActorHeaders(eventActor, eventReqId),
      body: JSON.stringify({ action: "invoice.exported", format: "pdf" }),
    },
    ctx.signal,
  );
  if (logged.status === 201) {
    ctx.recorder.expectedMutations.push({
      app: ctx.app,
      requestId: eventReqId,
      kind: "event",
      actor: eventActor,
      actorSource: ctx.app === "prisma-api" ? "set_config" : "comment",
      expectedEvents: [
        { source: "app", tableName: null, op: "invoice.exported", recordId: invoiceId },
      ],
    });
  } else {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/events status=${logged.status}`);
  }

  if (cycle % 2 === 0 && !ctx.signal.aborted) {
    await runActivityPagination(ctx);
  }
  if (cycle % 3 === 0 && !ctx.signal.aborted) {
    await runMidFlightAbort(ctx, seed + 7);
  }
  if (ctx.signal.aborted) {
    return;
  }

  const delActor = pickActor(seed + 9, false);
  const delReqId = nextReqId(ctx);
  const deleted = await sendRequest(
    ctx.recorder,
    `${ctx.baseUrl}/invoices/${invoiceId}`,
    {
      method: "DELETE",
      headers: buildActorHeaders(delActor, delReqId),
    },
    ctx.signal,
  );
  if (deleted.status === 200) {
    const deleteEvents: ExpectedEventSpec[] = [
      { source: "db", tableName: "invoice", op: "DELETE", recordId: invoiceId },
      ...lineItemIds.map((id) => ({
        source: "db" as const,
        tableName: "line_item",
        op: "DELETE",
        recordId: id,
      })),
    ];
    ctx.recorder.expectedMutations.push({
      app: ctx.app,
      requestId: delReqId,
      kind: "delete",
      actor: delActor,
      actorSource: "comment",
      expectedEvents: deleteEvents,
    });
  } else {
    recordUnexpectedHttp(ctx.recorder, `${ctx.app}/delete status=${deleted.status}`);
  }
}

async function runSingleCycle(ctx: WorkerContext, cycle: number): Promise<void> {
  const seed = ctx.workerId * 97 + cycle * 13;
  const invoiceId = await createAndPatchInvoice(ctx, cycle, seed);
  if (invoiceId === null || ctx.signal.aborted) {
    return;
  }
  const lineItemIds =
    ctx.app === "hono-drizzle"
      ? await runDrizzleSpecificSteps(ctx, invoiceId, seed)
      : await runPrismaSpecificSteps(ctx, invoiceId, seed);
  if (ctx.signal.aborted) {
    return;
  }
  await logAndDeleteInvoice(ctx, invoiceId, lineItemIds, cycle, seed);
}

async function runWorkerLoop(
  ctx: WorkerContext,
  deadlineMs: number,
  onFatalError: (err: unknown) => void,
): Promise<void> {
  let cycle = 0;
  while (Date.now() < deadlineMs && !ctx.signal.aborted) {
    cycle += 1;
    try {
      await runSingleCycle(ctx, cycle);
    } catch (err) {
      if (ctx.signal.aborted && isAbortError(err)) {
        return;
      }
      onFatalError(err);
      return;
    }
  }
}

export async function runConcurrentWorkers(options: {
  readonly runId: string;
  readonly honoBaseUrl: string;
  readonly prismaBaseUrl: string;
  readonly concurrency: number;
  readonly durationSeconds: number;
  readonly recorder: WorkloadRecorder;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const deadlineMs = Date.now() + options.durationSeconds * 1000;
  const workerController = new AbortController();
  const onExternalAbort = (): void => workerController.abort();
  if (options.signal?.aborted) {
    workerController.abort();
  } else {
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  let seq = 0;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  let firstError: unknown = null;
  const onFatalError = (err: unknown): void => {
    if (firstError === null) {
      firstError = err;
      workerController.abort();
    }
  };

  const honoWorkers = Math.max(1, Math.floor(options.concurrency / 2));
  const prismaWorkers = Math.max(1, options.concurrency - honoWorkers);
  const workers: Promise<void>[] = [];

  for (let i = 1; i <= honoWorkers; i += 1) {
    workers.push(
      runWorkerLoop(
        {
          runId: options.runId,
          app: "hono-drizzle",
          baseUrl: options.honoBaseUrl,
          workerId: i,
          recorder: options.recorder,
          signal: workerController.signal,
          nextSeq,
        },
        deadlineMs,
        onFatalError,
      ),
    );
  }
  for (let i = 1; i <= prismaWorkers; i += 1) {
    workers.push(
      runWorkerLoop(
        {
          runId: options.runId,
          app: "prisma-api",
          baseUrl: options.prismaBaseUrl,
          workerId: honoWorkers + i,
          recorder: options.recorder,
          signal: workerController.signal,
          nextSeq,
        },
        deadlineMs,
        onFatalError,
      ),
    );
  }

  try {
    await Promise.allSettled(workers);
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }

  if (firstError !== null) {
    throw firstError;
  }
}
