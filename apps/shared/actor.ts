/**
 * Shared demo-only actor & request-context helpers for `auditstream-lab` HTTP apps.
 *
 * Real production applications must resolve actors and tenants from a verified
 * session or JWT and fail closed (`401`/`403`) on unauthenticated requests.
 */

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PG_INT4_MAX = 2_147_483_647;

export interface DemoActor {
  readonly type: "user" | "ai_agent";
  readonly id: string;
  readonly tenant?: string;
  readonly onBehalfOf?: {
    readonly type: "user";
    readonly id: string;
  };
}

export interface DemoContext {
  readonly source: string;
  readonly requestId?: string;
}

export type HeaderReader = (name: string) => string | undefined;

export function sanitizeHeaderToken(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !SAFE_TOKEN_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * Resolves a human (`x-demo-user`) or delegated AI agent (`x-demo-agent` + optional
 * `x-demo-on-behalf-of`) actor from demo HTTP headers, with optional `x-demo-tenant`.
 */
export function resolveDemoActor(getHeader: HeaderReader): DemoActor | undefined {
  const tenant = sanitizeHeaderToken(getHeader("x-demo-tenant"));
  const agentId = sanitizeHeaderToken(getHeader("x-demo-agent"));

  if (agentId) {
    const onBehalfOfId = sanitizeHeaderToken(getHeader("x-demo-on-behalf-of"));
    return {
      type: "ai_agent",
      id: agentId,
      ...(tenant ? { tenant } : {}),
      ...(onBehalfOfId ? { onBehalfOf: { type: "user", id: onBehalfOfId } } : {}),
    };
  }

  const userId = sanitizeHeaderToken(getHeader("x-demo-user"));
  if (!userId) {
    return undefined;
  }

  return {
    type: "user",
    id: userId,
    ...(tenant ? { tenant } : {}),
  };
}

export function resolveDemoContext(getHeader: HeaderReader, source: string): DemoContext {
  const requestId = sanitizeHeaderToken(getHeader("x-request-id"));
  return requestId ? { source, requestId } : { source };
}

export function createDemoAuditOptions(source: string): {
  readonly actor: (c: { readonly req: { header(name: string): string | undefined } }) =>
    | DemoActor
    | undefined;
  readonly context: (c: { readonly req: { header(name: string): string | undefined } }) => DemoContext;
} {
  return {
    actor: (c) => resolveDemoActor((name) => c.req.header(name)),
    context: (c) => resolveDemoContext((name) => c.req.header(name), source),
  };
}

/**
 * Parses a positive PostgreSQL 32-bit signed integer (`1..=2147483647`).
 */
export function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= PG_INT4_MAX ? parsed : null;
}

/**
 * Parses a non-negative `numeric(12, 2)` string. Applies `fallback` only when `raw` is
 * strictly `undefined`; any non-string input (including numbers or `null`) returns `null`.
 */
export function parseDecimalAmount(raw: unknown, fallback?: string): string | null {
  if (raw === undefined) {
    return fallback ?? null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}
