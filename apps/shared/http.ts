/**
 * Shared request-body parsers, HTTP route handlers, database error helpers,
 * and server lifecycle utilities with zero external runtime dependencies.
 */

import {
  type ActivityFeedItem,
  type HistoryEntryLike,
  type ParsedActivityQuery,
  parseActivityQueryParams,
  projectHistoryEntry,
} from "./activity.ts";
import { parseDecimalAmount, parsePositiveInt } from "./actor.ts";

export const ERR_INVALID_INVOICE_ID = "Invalid invoice id";
export const ERR_INVOICE_NOT_FOUND = "Invoice not found";
export const ERR_INVALID_JSON_BODY = "Request body must be a valid JSON object";
export const ERR_INVALID_AMOUNT = "amount must be a non-negative decimal (max 2 decimals)";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_LOOKBACK_DAYS = 30;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface InvoiceCreateInput {
  readonly status: string;
  readonly total: string;
  readonly passwordHash: string | null;
}

export interface InvoicePatchInput {
  readonly status?: string;
  readonly total?: string;
  readonly passwordHash?: string | null;
}

export interface InvoiceView {
  readonly id: number;
  readonly status: string;
  readonly total: string;
}

export interface InvoiceRowLike {
  readonly id: number;
  readonly status: string;
  readonly total: string | { toFixed(fractionDigits: number): string };
}

export interface InvoiceEventPayload {
  readonly action: string;
  readonly target: { readonly id: number };
  readonly data: { readonly format: string };
}

export type HttpStatusCode = 200 | 201 | 400 | 404 | 409 | 500;

export interface HttpJsonResponse {
  readonly status: HttpStatusCode;
  readonly body: Record<string, unknown>;
}

export type JsonBodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

export type ParsedLineItemRequest =
  | {
      readonly ok: true;
      readonly id: number;
      readonly description: string;
      readonly amount: string;
      readonly body: Record<string, unknown>;
    }
  | { readonly ok: false; readonly response: HttpJsonResponse };

export interface ActivityQueryPageLike {
  readonly entries: readonly HistoryEntryLike[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface LabContextLike<TRes = unknown> {
  readonly req: {
    text(): Promise<string>;
    param(name: string): string;
    query(name: string): string | undefined;
  };
  json(data: Record<string, unknown>, status?: HttpStatusCode): TRes;
}

export interface LabRouteRegistrar<TRes = unknown> {
  get(path: string, handler: (c: LabContextLike<TRes>) => TRes | Promise<TRes>): unknown;
  post(path: string, handler: (c: LabContextLike<TRes>) => TRes | Promise<TRes>): unknown;
  patch(path: string, handler: (c: LabContextLike<TRes>) => TRes | Promise<TRes>): unknown;
  delete(path: string, handler: (c: LabContextLike<TRes>) => TRes | Promise<TRes>): unknown;
}

export interface SharedInvoiceRoutesConfig {
  readonly appName: string;
  readonly createInvoice: (input: InvoiceCreateInput) => Promise<InvoiceRowLike | null>;
  readonly updateInvoice: (id: number, input: InvoicePatchInput) => Promise<InvoiceRowLike | null>;
  readonly deleteInvoice: (id: number) => Promise<number | null>;
  readonly logEvent: (event: InvoiceEventPayload) => Promise<unknown>;
  readonly queryActivity: (
    query: ParsedActivityQuery & { readonly since: Date },
  ) => Promise<ActivityQueryPageLike>;
  readonly isAuditError: (err: unknown) => err is Error;
}

export interface CloseableServer {
  close(cb?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface SignalTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
  readonly shutdownTimeoutMs?: number;
  readonly exit?: (code: number) => void;
  readonly signalTarget?: SignalTarget;
}

export function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }
  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`PORT out of range (1..65535): ${raw}`);
  }
  return port;
}

/**
 * Parses an HTTP request body as a plain JSON object. Empty bodies map to `{}`;
 * malformed JSON or non-object JSON values (arrays, primitives, `null`) fail with `400`.
 */
export async function readJsonBody(readText: () => Promise<string>): Promise<JsonBodyResult> {
  const rawText = (await readText()).trim();
  if (rawText.length === 0) {
    return { ok: true, value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: ERR_INVALID_JSON_BODY };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: ERR_INVALID_JSON_BODY };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Strictly validates an optional non-empty string field. Missing/`undefined` fields return
 * `{ ok: true, value: undefined }`; non-string or blank strings return `{ ok: false, error }`.
 */
export function parseOptionalStringField(
  record: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
  const value = record[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${key} must be a non-empty string` };
  }
  const trimmed = value.trim();
  return trimmed.length > 0
    ? { ok: true, value: trimmed }
    : { ok: false, error: `${key} must be a non-empty string` };
}

/**
 * Strictly validates an optional nullable string field (e.g., `passwordHash`).
 * Allows omitted/`undefined`, `null`, or `string`; rejects all other JSON types.
 */
function parseNullableStringField(
  record: Record<string, unknown>,
  key: string,
):
  | { readonly ok: true; readonly present: false; readonly value: undefined }
  | { readonly ok: true; readonly present: true; readonly value: string | null }
  | { readonly ok: false; readonly error: string } {
  const value = record[key];
  if (value === undefined) {
    return { ok: true, present: false, value: undefined };
  }
  if (value === null || typeof value === "string") {
    return { ok: true, present: true, value };
  }
  return { ok: false, error: `${key} must be a string or null` };
}

export function serializeInvoice(row: InvoiceRowLike): InvoiceView {
  return {
    id: row.id,
    status: row.status,
    total: typeof row.total === "string" ? row.total : row.total.toFixed(2),
  };
}

export function parseCreateInvoiceInput(
  body: Record<string, unknown>,
): InvoiceCreateInput | { readonly error: string } {
  const statusField = parseOptionalStringField(body, "status");
  if (!statusField.ok) {
    return { error: statusField.error };
  }
  const total = parseDecimalAmount(body.total, "0.00");
  if (total === null) {
    return { error: "total must be a non-negative decimal (max 2 decimals)" };
  }
  const passwordField = parseNullableStringField(body, "passwordHash");
  if (!passwordField.ok) {
    return { error: passwordField.error };
  }
  return {
    status: statusField.value ?? "draft",
    total,
    passwordHash: passwordField.present ? passwordField.value : null,
  };
}

export function parsePatchInvoiceInput(
  body: Record<string, unknown>,
): InvoicePatchInput | { readonly error: string } {
  const statusField = parseOptionalStringField(body, "status");
  if (!statusField.ok) {
    return { error: statusField.error };
  }

  let total: string | undefined;
  if ("total" in body && body.total !== undefined) {
    const parsedTotal = parseDecimalAmount(body.total);
    if (parsedTotal === null) {
      return { error: "total must be a non-negative decimal (max 2 decimals)" };
    }
    total = parsedTotal;
  }

  const passwordField = parseNullableStringField(body, "passwordHash");
  if (!passwordField.ok) {
    return { error: passwordField.error };
  }

  if (statusField.value === undefined && total === undefined && !passwordField.present) {
    return { error: "Provide at least one field: status, total, or passwordHash" };
  }
  return {
    ...(statusField.value !== undefined ? { status: statusField.value } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(passwordField.present ? { passwordHash: passwordField.value } : {}),
  };
}

export function parseLineItemBody(
  body: Record<string, unknown>,
  defaultDescription: string,
  defaultAmount: string,
): { readonly description: string; readonly amount: string } | { readonly error: string } {
  const descriptionField = parseOptionalStringField(body, "description");
  if (!descriptionField.ok) {
    return { error: descriptionField.error };
  }
  const amount = parseDecimalAmount(body.amount, defaultAmount);
  if (amount === null) {
    return { error: ERR_INVALID_AMOUNT };
  }
  return { description: descriptionField.value ?? defaultDescription, amount };
}

export async function parseInvoiceLineItemRequest(
  rawId: string,
  readText: () => Promise<string>,
  defaultDescription: string,
  defaultAmount: string,
): Promise<ParsedLineItemRequest> {
  const id = parsePositiveInt(rawId);
  if (id === null) {
    return { ok: false, response: { status: 400, body: { error: ERR_INVALID_INVOICE_ID } } };
  }
  const bodyResult = await readJsonBody(readText);
  if (!bodyResult.ok) {
    return { ok: false, response: { status: 400, body: { error: bodyResult.error } } };
  }
  const parsed = parseLineItemBody(bodyResult.value, defaultDescription, defaultAmount);
  if ("error" in parsed) {
    return { ok: false, response: { status: 400, body: { error: parsed.error } } };
  }
  return {
    ok: true,
    id,
    description: parsed.description,
    amount: parsed.amount,
    body: bodyResult.value,
  };
}

export function getPgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const record = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof record.code === "string") {
    return record.code;
  }
  return typeof record.cause?.code === "string" ? record.cause.code : undefined;
}

export async function handleCreateInvoice(
  readText: () => Promise<string>,
  createRow: (input: InvoiceCreateInput) => Promise<InvoiceRowLike | null>,
): Promise<HttpJsonResponse> {
  const body = await readJsonBody(readText);
  if (!body.ok) {
    return { status: 400, body: { error: body.error } };
  }
  const parsed = parseCreateInvoiceInput(body.value);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  const created = await createRow(parsed);
  if (!created) {
    return { status: 500, body: { error: "Failed to create invoice" } };
  }
  return { status: 201, body: { ...serializeInvoice(created) } };
}

export async function handlePatchInvoice(
  rawId: string,
  readText: () => Promise<string>,
  updateRow: (id: number, input: InvoicePatchInput) => Promise<InvoiceRowLike | null>,
): Promise<HttpJsonResponse> {
  const id = parsePositiveInt(rawId);
  if (id === null) {
    return { status: 400, body: { error: ERR_INVALID_INVOICE_ID } };
  }
  const body = await readJsonBody(readText);
  if (!body.ok) {
    return { status: 400, body: { error: body.error } };
  }
  const parsed = parsePatchInvoiceInput(body.value);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  const updated = await updateRow(id, parsed);
  if (!updated) {
    return { status: 404, body: { error: ERR_INVOICE_NOT_FOUND } };
  }
  return { status: 200, body: { ...serializeInvoice(updated) } };
}

export async function handleDeleteInvoice(
  rawId: string,
  deleteRow: (id: number) => Promise<number | null>,
): Promise<HttpJsonResponse> {
  const id = parsePositiveInt(rawId);
  if (id === null) {
    return { status: 400, body: { error: ERR_INVALID_INVOICE_ID } };
  }
  const deletedId = await deleteRow(id);
  if (deletedId === null) {
    return { status: 404, body: { error: ERR_INVOICE_NOT_FOUND } };
  }
  return { status: 200, body: { deleted: true, id: deletedId } };
}

export async function handleLogInvoiceEvent(
  rawId: string,
  readText: () => Promise<string>,
  logEvent: (event: InvoiceEventPayload) => Promise<unknown>,
  isAuditError: (err: unknown) => err is Error,
): Promise<HttpJsonResponse> {
  const id = parsePositiveInt(rawId);
  if (id === null) {
    return { status: 400, body: { error: ERR_INVALID_INVOICE_ID } };
  }
  const body = await readJsonBody(readText);
  if (!body.ok) {
    return { status: 400, body: { error: body.error } };
  }
  const actionField = parseOptionalStringField(body.value, "action");
  if (!actionField.ok) {
    return { status: 400, body: { error: actionField.error } };
  }
  const formatField = parseOptionalStringField(body.value, "format");
  if (!formatField.ok) {
    return { status: 400, body: { error: formatField.error } };
  }
  const action = actionField.value ?? "invoice.exported";
  const format = formatField.value ?? "pdf";

  try {
    await logEvent({ action, target: { id }, data: { format } });
  } catch (err) {
    if (isAuditError(err)) {
      return { status: 400, body: { error: err.message } };
    }
    throw err;
  }
  return { status: 201, body: { logged: true, action, id } };
}

export async function handleGetActivity(
  getQuery: (name: string) => string | undefined,
  runQuery: (query: ParsedActivityQuery & { readonly since: Date }) => Promise<ActivityQueryPageLike>,
  isAuditError: (err: unknown) => err is Error,
): Promise<HttpJsonResponse> {
  const parsed = parseActivityQueryParams(getQuery);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }
  const since = new Date(Date.now() - DEFAULT_ACTIVITY_LOOKBACK_DAYS * MS_PER_DAY);
  try {
    const page = await runQuery({ ...parsed, since });
    const items: ActivityFeedItem[] = page.entries.map(projectHistoryEntry);
    return {
      status: 200,
      body: { items, nextCursor: page.nextCursor, hasMore: page.hasMore },
    };
  } catch (err) {
    if (isAuditError(err)) {
      return { status: 400, body: { error: err.message } };
    }
    throw err;
  }
}

/**
 * Registers the shared health, invoice CRUD, application-event, and allowlisted activity-feed
 * routes onto any Hono-compatible router without pulling framework dependencies into `apps/shared/`.
 */
export function mountSharedInvoiceRoutes<TRes>(
  app: LabRouteRegistrar<TRes>,
  config: SharedInvoiceRoutesConfig,
): void {
  app.get("/health", (c) => c.json({ ok: true, app: config.appName }));

  app.post("/invoices", async (c) => {
    const res = await handleCreateInvoice(() => c.req.text(), config.createInvoice);
    return c.json(res.body, res.status);
  });

  app.patch("/invoices/:id", async (c) => {
    const res = await handlePatchInvoice(c.req.param("id"), () => c.req.text(), config.updateInvoice);
    return c.json(res.body, res.status);
  });

  app.delete("/invoices/:id", async (c) => {
    const res = await handleDeleteInvoice(c.req.param("id"), config.deleteInvoice);
    return c.json(res.body, res.status);
  });

  app.post("/invoices/:id/events", async (c) => {
    const res = await handleLogInvoiceEvent(
      c.req.param("id"),
      () => c.req.text(),
      config.logEvent,
      config.isAuditError,
    );
    return c.json(res.body, res.status);
  });

  app.get("/activity", async (c) => {
    const res = await handleGetActivity(
      (name) => c.req.query(name),
      config.queryActivity,
      config.isAuditError,
    );
    return c.json(res.body, res.status);
  });
}

/**
 * Prevents unhandled `'error'` events on idle `pg.Pool` clients from crashing the Node process
 * when PgBouncer or PostgreSQL recycles an idle backend connection.
 */
export function attachPoolErrorHandler(
  pool: { on(event: "error", listener: (err: Error) => void): unknown },
  appName: string,
): void {
  pool.on("error", (err) => {
    console.error(`[${appName}] idle pg pool error:`, err.message);
  });
}

export function registerGracefulShutdown(
  server: CloseableServer,
  closeDb: () => Promise<void>,
  options: GracefulShutdownOptions = {},
): void {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signalTarget = options.signalTarget ?? process;
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      exit(1);
    }, shutdownTimeoutMs);
    timer.unref();

    server.closeIdleConnections?.();
    server.close(() => {
      closeDb().then(
        () => {
          clearTimeout(timer);
          exit(0);
        },
        (err: unknown) => {
          console.error("Failed to close database pool cleanly:", err);
          clearTimeout(timer);
          exit(1);
        },
      );
    });
  };

  signalTarget.on("SIGINT", shutdown);
  signalTarget.on("SIGTERM", shutdown);
}

export function startLabServer<THandle extends { close(): Promise<void> }, TFetch>(options: {
  readonly appName: string;
  readonly defaultPort: number;
  readonly createHandle: (databaseUrl: string) => THandle;
  readonly createAppFetch: (handle: THandle) => TFetch;
  readonly startServer: (
    fetch: TFetch,
    port: number,
    onListening: (port: number) => void,
  ) => CloseableServer;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly shutdownOptions?: GracefulShutdownOptions;
}): void {
  const env = options.env ?? process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const port = parsePort(env.PORT, options.defaultPort);
  const handle = options.createHandle(databaseUrl);
  const fetch = options.createAppFetch(handle);
  const server = options.startServer(fetch, port, (listeningPort) => {
    console.log(`${options.appName} lab listening on http://127.0.0.1:${listeningPort}`);
  });
  registerGracefulShutdown(server, () => handle.close(), options.shutdownOptions);
}
