/**
 * Shared types for the `auditstream-lab` concurrent soak driver and invariant oracle.
 */

export type AppName = "hono-drizzle" | "prisma-api";

export interface ActorSpec {
  readonly type: "user" | "ai_agent";
  readonly id: string;
  readonly tenant: string;
  readonly onBehalfOf?: {
    readonly type: "user";
    readonly id: string;
  };
}

export type ExpectedActorSource = "comment" | "set_config";

export interface ExpectedEventSpec {
  readonly source: "db" | "app";
  readonly tableName: string | null;
  readonly op: string;
  readonly recordId: number;
}

export interface ExpectedMutation {
  readonly app: AppName;
  readonly requestId: string;
  readonly kind: "create" | "patch" | "finalize" | "raw-note" | "approve" | "event" | "delete";
  readonly actor: ActorSpec;
  readonly actorSource: ExpectedActorSource;
  readonly expectedEvents: readonly ExpectedEventSpec[];
}

export interface AbortedRequestRecord {
  readonly app: AppName;
  readonly requestId: string;
  readonly actor: ActorSpec;
  readonly actorSource: ExpectedActorSource;
}

export interface ForbiddenRequestRecord {
  readonly app: AppName;
  readonly requestId: string;
  readonly reason: "rollback" | "excluded-only";
}

export interface DirectSqlRecord {
  readonly app: AppName;
  readonly markerStatus: string;
}

export interface TamperProbeSummary {
  readonly attempts: number;
  readonly rejected42501: number;
  readonly unexpectedErrors: readonly string[];
}

export interface PreparedStatementProbeSummary {
  readonly app: AppName;
  readonly distinctBackends: number;
  readonly expectedBackends: number;
  readonly leakedCount: number;
}

export interface VerifySummary {
  readonly app: AppName;
  readonly ok: boolean;
  readonly findingsCount: number;
}

export interface ExportedEvent {
  readonly event_id?: unknown;
  readonly source?: unknown;
  readonly table_name?: unknown;
  readonly op?: unknown;
  readonly record_id?: unknown;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly changed?: unknown;
  readonly actor?: unknown;
  readonly context?: unknown;
  readonly actor_source?: unknown;
}

export interface SoakRunMetrics {
  readonly runId: string;
  readonly durationSeconds: number;
  readonly elapsedMs: number;
  readonly concurrency: number;
  readonly totalRequests: number;
  readonly http5xxCount: number;
  readonly unexpectedHttpCount: number;
  readonly unexpectedHttpSamples: readonly string[];
  readonly activityReads: number;
  readonly exportCycles: Readonly<Record<AppName, number>>;
  readonly latenciesMs: readonly number[];
}

export interface OracleInput {
  readonly metrics: SoakRunMetrics;
  readonly expectedMutations: readonly ExpectedMutation[];
  readonly abortedRequests: readonly AbortedRequestRecord[];
  readonly forbiddenRequests: readonly ForbiddenRequestRecord[];
  readonly directSqlWrites: readonly DirectSqlRecord[];
  readonly exportedByApp: Readonly<Record<AppName, readonly ExportedEvent[]>>;
  readonly parseErrorsByApp: Readonly<Record<AppName, number>>;
  readonly tamper: TamperProbeSummary;
  readonly preparedStatements: readonly PreparedStatementProbeSummary[];
  readonly verifyResults: readonly VerifySummary[];
}

export interface InvariantCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface LatencySummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface SoakReport {
  readonly passed: boolean;
  readonly runId: string;
  readonly durationSeconds: number;
  readonly elapsedSeconds: number;
  readonly concurrency: number;
  readonly requests: number;
  readonly rps: number;
  readonly latencyMs: LatencySummary;
  readonly exportedEvents: number;
  readonly exportCycles: Readonly<Record<AppName, number>>;
  readonly committedMutations: number;
  readonly abortedRequests: number;
  readonly activityReads: number;
  readonly tamperAttempts: number;
  readonly invariants: readonly InvariantCheck[];
}
