import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
  parseActivityQueryParams,
  projectHistoryEntry,
} from "../apps/shared/activity.ts";
import {
  PG_INT4_MAX,
  createDemoAuditOptions,
  parseDecimalAmount,
  parsePositiveInt,
  resolveDemoActor,
  resolveDemoContext,
} from "../apps/shared/actor.ts";
import {
  type CloseableServer,
  ERR_INVALID_AMOUNT,
  ERR_INVALID_INVOICE_ID,
  ERR_INVALID_JSON_BODY,
  ERR_INVOICE_NOT_FOUND,
  type LabContextLike,
  attachPoolErrorHandler,
  getPgErrorCode,
  handleCreateInvoice,
  handleDeleteInvoice,
  handleGetActivity,
  handleLogInvoiceEvent,
  handlePatchInvoice,
  mountSharedInvoiceRoutes,
  parseCreateInvoiceInput,
  parseInvoiceLineItemRequest,
  parseLineItemBody,
  parseOptionalStringField,
  parsePatchInvoiceInput,
  parsePort,
  readJsonBody,
  registerGracefulShutdown,
  serializeInvoice,
  startLabServer,
} from "../apps/shared/http.ts";

const SAMPLE_TIMESTAMP = "2026-11-26T00:00:00Z";
const PAID_STATUS_JSON = '{"status":"paid"}';
const DEFAULT_LINE_DESC = "Default desc";

class FakeAuditError extends Error {}

function createSignalHub() {
  const listeners: Record<"SIGINT" | "SIGTERM", Array<() => void>> = {
    SIGINT: [],
    SIGTERM: [],
  };
  return {
    target: {
      on(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners[signal].push(listener);
      },
    },
    emit(signal: "SIGINT" | "SIGTERM") {
      for (const listener of listeners[signal]) {
        listener();
      }
    },
  };
}

describe("actor helpers", () => {
  it("resolves human and delegated AI agent actors from headers", () => {
    const humanHeaders: Record<string, string> = {
      "x-demo-user": "alice",
      "x-demo-tenant": "acme",
    };
    assert.deepEqual(
      resolveDemoActor((k) => humanHeaders[k]),
      { type: "user", id: "alice", tenant: "acme" },
    );

    const agentHeaders: Record<string, string> = {
      "x-demo-agent": "bot_billing",
      "x-demo-on-behalf-of": "alice",
      "x-demo-tenant": "acme",
    };
    assert.deepEqual(
      resolveDemoActor((k) => agentHeaders[k]),
      {
        type: "ai_agent",
        id: "bot_billing",
        tenant: "acme",
        onBehalfOf: { type: "user", id: "alice" },
      },
    );

    assert.equal(
      resolveDemoActor(() => "bad value with spaces!"),
      undefined,
    );
  });

  it("enforces PostgreSQL INT4 bounds in parsePositiveInt", () => {
    assert.equal(parsePositiveInt("1"), 1);
    assert.equal(parsePositiveInt(String(PG_INT4_MAX)), PG_INT4_MAX);
    assert.equal(parsePositiveInt(String(PG_INT4_MAX + 1)), null);
    assert.equal(parsePositiveInt("0"), null);
    assert.equal(parsePositiveInt("-5"), null);
    assert.equal(parsePositiveInt("12abc"), null);
  });

  it("rejects non-string amounts instead of applying fallback defaults", () => {
    assert.equal(parseDecimalAmount(undefined, "0.00"), "0.00");
    assert.equal(parseDecimalAmount(undefined), null);
    assert.equal(parseDecimalAmount("125.50", "0.00"), "125.50");
    assert.equal(parseDecimalAmount(50, "0.00"), null);
    assert.equal(parseDecimalAmount(null, "0.00"), null);
    assert.equal(parseDecimalAmount(true, "0.00"), null);
    assert.equal(parseDecimalAmount("-10.00", "0.00"), null);
    assert.equal(parseDecimalAmount("1.234", "0.00"), null);
  });

  it("resolves sanitized request context and demo middleware options", () => {
    assert.deepEqual(
      resolveDemoContext((k) => (k === "x-request-id" ? "req-1" : undefined), "lab/test"),
      { source: "lab/test", requestId: "req-1" },
    );
    assert.deepEqual(
      resolveDemoContext(() => undefined, "lab/test"),
      { source: "lab/test" },
    );

    const opts = createDemoAuditOptions("lab/test");
    const fakeCtx = {
      req: {
        header: (k: string) => ({ "x-demo-user": "alice", "x-request-id": "req-2" })[k],
      },
    };
    assert.deepEqual(opts.actor(fakeCtx), { type: "user", id: "alice" });
    assert.deepEqual(opts.context(fakeCtx), { source: "lab/test", requestId: "req-2" });
  });
});

describe("activity feed helpers", () => {
  it("validates query params and bounds", () => {
    assert.deepEqual(
      parseActivityQueryParams(() => undefined),
      { limit: DEFAULT_ACTIVITY_LIMIT },
    );
    assert.deepEqual(
      parseActivityQueryParams(
        (k) => ({ limit: "5", source: "db", table: "invoice", cursor: "abc" })[k],
      ),
      { limit: 5, source: "db", table: "invoice", cursor: "abc" },
    );
    assert.ok(
      "error" in
        parseActivityQueryParams((k) =>
          k === "limit" ? String(MAX_ACTIVITY_LIMIT + 1) : undefined,
        ),
    );
    assert.ok("error" in parseActivityQueryParams((k) => (k === "source" ? "invalid" : undefined)));
    assert.ok(
      "error" in parseActivityQueryParams((k) => (k === "table" ? "bad;table" : undefined)),
    );
  });

  it("projects only allowlisted fields and ignores Object.prototype property names", () => {
    const projected = projectHistoryEntry({
      event_id: "evt-1",
      occurred_at: SAMPLE_TIMESTAMP,
      source: "db",
      table_name: "invoice",
      op: "UPDATE",
      record_id: { id: 42 },
      changed: ["status", "password_hash", "total"],
      actor: {
        id: "bot_billing",
        type: "ai_agent",
        onBehalfOf: { id: "alice", type: "user" },
      },
    });
    assert.deepEqual(projected, {
      eventId: "evt-1",
      occurredAt: SAMPLE_TIMESTAMP,
      source: "db",
      action: "UPDATE",
      entity: "invoice",
      recordId: "42",
      changedFields: ["status", "total"],
      actor: {
        id: "bot_billing",
        type: "ai_agent",
        onBehalfOf: { id: "alice", type: "user" },
      },
    });

    for (const protoTable of ["toString", "constructor", "valueOf"]) {
      const safe = projectHistoryEntry({
        event_id: "evt-proto",
        occurred_at: SAMPLE_TIMESTAMP,
        source: "db",
        table_name: protoTable,
        op: "UPDATE",
        record_id: { id: 1 },
        changed: ["status"],
        actor: null,
      });
      assert.deepEqual(safe.changedFields, []);
    }
  });
});

describe("http helpers and handlers", () => {
  it("parses JSON bodies strictly and rejects malformed or non-object JSON", async () => {
    assert.deepEqual(await readJsonBody(async () => ""), { ok: true, value: {} });
    assert.deepEqual(await readJsonBody(async () => PAID_STATUS_JSON), {
      ok: true,
      value: { status: "paid" },
    });
    assert.deepEqual(await readJsonBody(async () => "{invalid"), {
      ok: false,
      error: ERR_INVALID_JSON_BODY,
    });
    assert.deepEqual(await readJsonBody(async () => "[1,2,3]"), {
      ok: false,
      error: ERR_INVALID_JSON_BODY,
    });
    assert.deepEqual(await readJsonBody(async () => "null"), {
      ok: false,
      error: ERR_INVALID_JSON_BODY,
    });
  });

  it("serializes numeric(12, 2) consistently across string and Decimal objects", () => {
    assert.deepEqual(serializeInvoice({ id: 1, status: "draft", total: "80.00" }), {
      id: 1,
      status: "draft",
      total: "80.00",
    });
    assert.deepEqual(
      serializeInvoice({ id: 2, status: "draft", total: { toFixed: (d) => (80).toFixed(d) } }),
      { id: 2, status: "draft", total: "80.00" },
    );
  });

  it("strictly validates create, patch, line-item, and string fields", async () => {
    assert.deepEqual(parseOptionalStringField({}, "status"), { ok: true, value: undefined });
    assert.equal(parseOptionalStringField({ status: 123 }, "status").ok, false);
    assert.equal(parseOptionalStringField({ status: "   " }, "status").ok, false);

    assert.ok("error" in parseCreateInvoiceInput({ total: 50 }));
    assert.ok("error" in parseCreateInvoiceInput({ status: 123 }));
    assert.ok("error" in parseCreateInvoiceInput({ passwordHash: 123 }));
    assert.deepEqual(parseCreateInvoiceInput({ passwordHash: null }), {
      status: "draft",
      total: "0.00",
      passwordHash: null,
    });

    assert.ok("error" in parsePatchInvoiceInput({}));
    assert.ok("error" in parsePatchInvoiceInput({ status: 123, total: "10.00" }));
    assert.ok("error" in parsePatchInvoiceInput({ passwordHash: 123 }));
    assert.deepEqual(parsePatchInvoiceInput({ passwordHash: null }), { passwordHash: null });

    assert.deepEqual(parseLineItemBody({}, DEFAULT_LINE_DESC, "10.00"), {
      description: DEFAULT_LINE_DESC,
      amount: "10.00",
    });
    assert.deepEqual(parseLineItemBody({ amount: 15 }, DEFAULT_LINE_DESC, "10.00"), {
      error: ERR_INVALID_AMOUNT,
    });
    assert.ok("error" in parseLineItemBody({ description: 99 }, DEFAULT_LINE_DESC, "10.00"));

    const parsedLineReq = await parseInvoiceLineItemRequest(
      "7",
      async () => '{"amount":"12.50"}',
      DEFAULT_LINE_DESC,
      "10.00",
    );
    assert.equal(parsedLineReq.ok, true);
    if (parsedLineReq.ok) {
      assert.equal(parsedLineReq.id, 7);
      assert.equal(parsedLineReq.amount, "12.50");
      assert.equal(parsedLineReq.description, DEFAULT_LINE_DESC);
    }

    const badLineReq = await parseInvoiceLineItemRequest(
      "0",
      async () => "{}",
      DEFAULT_LINE_DESC,
      "10.00",
    );
    assert.equal(badLineReq.ok, false);

    assert.equal(parsePort(undefined, 3101), 3101);
    assert.equal(parsePort("8080", 3101), 8080);
    assert.throws(() => parsePort("99999", 3101));
    assert.equal(getPgErrorCode({ code: "P2025" }), "P2025");
    assert.equal(getPgErrorCode({ cause: { code: "23503" } }), "23503");

    let capturedListener: ((err: Error) => void) | undefined;
    attachPoolErrorHandler(
      {
        on(event, listener) {
          assert.equal(event, "error");
          capturedListener = listener;
        },
      },
      "test-app",
    );
    assert.equal(typeof capturedListener, "function");
    assert.doesNotThrow(() => capturedListener?.(new Error("idle reset")));
  });

  it("handles CRUD handlers across happy, 400, 404, and 500 paths", async () => {
    const created = await handleCreateInvoice(
      async () => '{"status":"draft","total":"50.00"}',
      async (input) => ({ id: 7, status: input.status, total: input.total }),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { id: 7, status: "draft", total: "50.00" });

    assert.equal((await handleCreateInvoice(async () => "{bad", async () => null)).status, 400);
    assert.equal((await handleCreateInvoice(async () => "{}", async () => null)).status, 500);

    const patchedNullHash = await handlePatchInvoice(
      "7",
      async () => '{"passwordHash":null}',
      async (id, input) => {
        assert.deepEqual(input, { passwordHash: null });
        return { id, status: "draft", total: "50.00" };
      },
    );
    assert.equal(patchedNullHash.status, 200);

    const patchNotFound = await handlePatchInvoice(
      "7",
      async () => PAID_STATUS_JSON,
      async () => null,
    );
    assert.equal(patchNotFound.status, 404);
    assert.equal(patchNotFound.body.error, ERR_INVOICE_NOT_FOUND);

    const overflow = await handlePatchInvoice(
      "2147483648",
      async () => PAID_STATUS_JSON,
      async () => null,
    );
    assert.equal(overflow.status, 400);
    assert.equal(overflow.body.error, ERR_INVALID_INVOICE_ID);

    assert.equal((await handleDeleteInvoice("7", async (id) => id)).status, 200);
    assert.equal((await handleDeleteInvoice("0", async () => null)).status, 400);
    assert.equal((await handleDeleteInvoice("99", async () => null)).status, 404);
  });

  it("maps AuditstreamError to 400 and rethrows unexpected errors in event and activity handlers", async () => {
    const isFakeAuditError = (err: unknown): err is Error => err instanceof FakeAuditError;

    const logged = await handleLogInvoiceEvent(
      "7",
      async () => '{"action":"invoice.exported","format":"csv"}',
      async () => undefined,
      isFakeAuditError,
    );
    assert.equal(logged.status, 201);

    const badAction = await handleLogInvoiceEvent(
      "7",
      async () => '{"action":123}',
      async () => undefined,
      isFakeAuditError,
    );
    assert.equal(badAction.status, 400);

    const auditLogErr = await handleLogInvoiceEvent(
      "7",
      async () => '{"action":"INSERT"}',
      async () => {
        throw new FakeAuditError("reserved action");
      },
      isFakeAuditError,
    );
    assert.equal(auditLogErr.status, 400);

    await assert.rejects(
      () =>
        handleLogInvoiceEvent(
          "7",
          async () => "{}",
          async () => {
            throw new Error("db down");
          },
          isFakeAuditError,
        ),
      /db down/,
    );

    const feed = await handleGetActivity(
      (k) => (k === "limit" ? "5" : undefined),
      async () => ({ entries: [], nextCursor: null, hasMore: false }),
      isFakeAuditError,
    );
    assert.equal(feed.status, 200);

    const feedAuditErr = await handleGetActivity(
      () => undefined,
      async () => {
        throw new FakeAuditError("bad cursor");
      },
      isFakeAuditError,
    );
    assert.equal(feedAuditErr.status, 400);

    await assert.rejects(
      () =>
        handleGetActivity(
          () => undefined,
          async () => {
            throw new Error("connection lost");
          },
          isFakeAuditError,
        ),
      /connection lost/,
    );
  });

  it("mounts all 6 shared routes via mountSharedInvoiceRoutes", async () => {
    type FakeResp = { readonly data: Record<string, unknown>; readonly status?: number };
    const routes = new Map<string, (c: LabContextLike<FakeResp>) => FakeResp | Promise<FakeResp>>();
    mountSharedInvoiceRoutes<FakeResp>(
      {
        get: (p, h) => routes.set(`GET ${p}`, h),
        post: (p, h) => routes.set(`POST ${p}`, h),
        patch: (p, h) => routes.set(`PATCH ${p}`, h),
        delete: (p, h) => routes.set(`DELETE ${p}`, h),
      },
      {
        appName: "test-lab",
        createInvoice: async () => ({ id: 1, status: "draft", total: "10.00" }),
        updateInvoice: async () => ({ id: 1, status: "paid", total: "10.00" }),
        deleteInvoice: async () => 1,
        logEvent: async () => undefined,
        queryActivity: async () => ({ entries: [], nextCursor: null, hasMore: false }),
        isAuditError: (err): err is Error => err instanceof FakeAuditError,
      },
    );

    assert.deepEqual([...routes.keys()].sort(), [
      "DELETE /invoices/:id",
      "GET /activity",
      "GET /health",
      "PATCH /invoices/:id",
      "POST /invoices",
      "POST /invoices/:id/events",
    ]);

    const healthHandler = routes.get("GET /health");
    assert.ok(healthHandler);
    const health = await healthHandler({
      req: { text: async () => "", param: () => "", query: () => undefined },
      json: (data, status) => (status === undefined ? { data } : { data, status }),
    });
    assert.deepEqual(health.data, { ok: true, app: "test-lab" });
  });
});

describe("server lifecycle helpers", () => {
  it("handles clean shutdown, duplicate signal idempotency, closeDb failure, and timeout", async () => {
    const hub1 = createSignalHub();
    let closeCalls = 0;
    let idleClosed = 0;
    const exits1: number[] = [];
    const server1: CloseableServer = {
      close(cb) {
        closeCalls += 1;
        cb?.();
      },
      closeIdleConnections() {
        idleClosed += 1;
      },
    };
    registerGracefulShutdown(server1, async () => undefined, {
      signalTarget: hub1.target,
      exit: (code) => exits1.push(code),
    });
    hub1.emit("SIGINT");
    hub1.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls, 1);
    assert.equal(idleClosed, 1);
    assert.deepEqual(exits1, [0]);

    const hub2 = createSignalHub();
    const exits2: number[] = [];
    const server2: CloseableServer = {
      close(cb) {
        cb?.();
      },
    };
    registerGracefulShutdown(
      server2,
      async () => {
        throw new Error("pool close failed");
      },
      {
        signalTarget: hub2.target,
        exit: (code) => exits2.push(code),
      },
    );
    hub2.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits2, [1]);

    const hub3 = createSignalHub();
    let forcedAllClosed = 0;
    const exits3: number[] = [];
    const server3: CloseableServer = {
      close() {
        // Deliberately never invokes callback to exercise forced timeout.
      },
      closeAllConnections() {
        forcedAllClosed += 1;
      },
    };
    registerGracefulShutdown(server3, async () => undefined, {
      shutdownTimeoutMs: 20,
      signalTarget: hub3.target,
      exit: (code) => exits3.push(code),
    });
    hub3.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(forcedAllClosed, 1);
    assert.deepEqual(exits3, [1]);
  });

  it("validates env and wires startLabServer", () => {
    assert.throws(
      () =>
        startLabServer({
          appName: "test",
          defaultPort: 3101,
          createHandle: () => ({ close: async () => undefined }),
          createAppFetch: () => ({}),
          startServer: () => ({ close: () => undefined }),
          env: {},
        }),
      /DATABASE_URL is required/,
    );

    assert.throws(
      () =>
        startLabServer({
          appName: "test",
          defaultPort: 3101,
          createHandle: () => ({ close: async () => undefined }),
          createAppFetch: () => ({}),
          startServer: () => ({ close: () => undefined }),
          env: { DATABASE_URL: "postgresql://localhost/test", PORT: "not-a-port" },
        }),
      /Invalid PORT/,
    );

    const hub = createSignalHub();
    let boundPort = 0;
    startLabServer({
      appName: "test",
      defaultPort: 3101,
      createHandle: () => ({ close: async () => undefined }),
      createAppFetch: () => "fetch-fn",
      startServer: (fetch, port, onListening) => {
        assert.equal(fetch, "fetch-fn");
        boundPort = port;
        onListening(port);
        return { close: () => undefined };
      },
      env: { DATABASE_URL: "postgresql://localhost/test", PORT: "4200" },
      shutdownOptions: { signalTarget: hub.target, exit: () => undefined },
    });
    assert.equal(boundPort, 4200);
  });
});
