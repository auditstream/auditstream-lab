/**
 * Shared allowlisted BFF Activity Feed projection helpers.
 *
 * Strictly projects only client-safe fields — omits internal DB metadata (`id`, `xact_id`,
 * `table_oid`, `db_user`, `actor_source`, `schema_version`), raw `before`/`after` row images,
 * excluded columns (`password_hash`), and request `context`.
 */

import { sanitizeHeaderToken } from "./actor.ts";

export const DEFAULT_ACTIVITY_LIMIT = 20;
export const MAX_ACTIVITY_LIMIT = 100;

const ALLOWED_FIELDS_BY_TABLE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["invoice", new Set(["status", "total"])],
  ["line_item", new Set(["description", "amount", "invoice_id"])],
]);

export interface HistoryActorLike {
  readonly id: string;
  readonly type: string;
  readonly onBehalfOf?:
    | {
        readonly id: string;
        readonly type: string;
      }
    | undefined;
}

export interface HistoryEntryLike {
  readonly event_id: string;
  readonly occurred_at: string;
  readonly source: "db" | "app";
  readonly table_name: string | null;
  readonly op: string;
  readonly record_id: Readonly<Record<string, unknown>> | null;
  readonly changed: readonly string[] | null;
  readonly actor: HistoryActorLike | null;
}

export interface ActivityFeedItem {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly source: "db" | "app";
  readonly action: string;
  readonly entity: string;
  readonly recordId: string | null;
  readonly changedFields: readonly string[];
  readonly actor: {
    readonly id: string;
    readonly type: string;
    readonly onBehalfOf?: {
      readonly id: string;
      readonly type: string;
    };
  } | null;
}

export interface ParsedActivityQuery {
  readonly source?: "db" | "app";
  readonly table?: string;
  readonly cursor?: string;
  readonly limit: number;
}

function parseActivityLimit(
  raw: string | undefined,
): { readonly value: number } | { readonly error: string } {
  if (raw === undefined || raw === "") {
    return { value: DEFAULT_ACTIVITY_LIMIT };
  }
  if (!/^\d+$/.test(raw)) {
    return { error: "limit must be a positive integer" };
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1 || parsed > MAX_ACTIVITY_LIMIT) {
    return { error: `limit must be between 1 and ${MAX_ACTIVITY_LIMIT}` };
  }
  return { value: parsed };
}

function parseActivitySource(
  raw: string | undefined,
): { readonly value: "db" | "app" | undefined } | { readonly error: string } {
  if (raw === undefined || raw === "") {
    return { value: undefined };
  }
  if (raw !== "db" && raw !== "app") {
    return { error: "source must be 'db' or 'app'" };
  }
  return { value: raw };
}

function parseActivityTable(
  raw: string | undefined,
): { readonly value: string | undefined } | { readonly error: string } {
  if (!raw) {
    return { value: undefined };
  }
  const table = sanitizeHeaderToken(raw);
  return table ? { value: table } : { error: "invalid table filter" };
}

export function parseActivityQueryParams(
  getParam: (name: string) => string | undefined,
): ParsedActivityQuery | { readonly error: string } {
  const limit = parseActivityLimit(getParam("limit"));
  if ("error" in limit) {
    return limit;
  }

  const source = parseActivitySource(getParam("source"));
  if ("error" in source) {
    return source;
  }

  const table = parseActivityTable(getParam("table"));
  if ("error" in table) {
    return table;
  }

  const trimmedCursor = getParam("cursor")?.trim();
  return {
    limit: limit.value,
    ...(source.value ? { source: source.value } : {}),
    ...(table.value ? { table: table.value } : {}),
    ...(trimmedCursor ? { cursor: trimmedCursor } : {}),
  };
}

function formatRecordId(recordId: Readonly<Record<string, unknown>> | null): string | null {
  if (!recordId) {
    return null;
  }
  const entries = Object.entries(recordId);
  if (entries.length === 1 && entries[0]?.[0] === "id") {
    return String(entries[0][1]);
  }
  return JSON.stringify(recordId);
}

function projectActor(actor: HistoryActorLike | null): ActivityFeedItem["actor"] {
  if (!actor) {
    return null;
  }
  return {
    id: actor.id,
    type: actor.type,
    ...(actor.onBehalfOf
      ? {
          onBehalfOf: {
            id: actor.onBehalfOf.id,
            type: actor.onBehalfOf.type,
          },
        }
      : {}),
  };
}

export function projectHistoryEntry(entry: HistoryEntryLike): ActivityFeedItem {
  const entity = entry.table_name ?? "app";
  const allowlist = entry.table_name ? ALLOWED_FIELDS_BY_TABLE.get(entry.table_name) : undefined;
  const changedFields =
    entry.changed && allowlist ? entry.changed.filter((field) => allowlist.has(field)) : [];

  return {
    eventId: entry.event_id,
    occurredAt: entry.occurred_at,
    source: entry.source,
    action: entry.op,
    entity,
    recordId: formatRecordId(entry.record_id),
    changedFields,
    actor: projectActor(entry.actor),
  };
}
