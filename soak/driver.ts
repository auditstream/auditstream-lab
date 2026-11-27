/**
 * Main soak orchestrator for `auditstream-lab`:
 *   1. Starts compiled `hono-drizzle` and `prisma-api` servers directly via PgBouncer (`app_user`).
 *   2. Drives parallel HTTP workers + periodic tamper/direct-SQL probes + parallel incremental
 *      `auditstream export --cursor-file` loops under separated graceful-stop and hard-abort
 *      coordination.
 *   3. Probes all 6 PgBouncer pooled backend connections for `pg_prepared_statements` leaks.
 *   4. Stops HTTP servers gracefully so `pg_snapshot_xmin` advances, runs final `auditstream export`
 *      drain and `auditstream verify`, evaluates the pure invariant oracle, and writes reports.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateOracle, formatMarkdownReport, parseJsonlContent } from "./oracle.ts";
import type {
  AppName,
  DirectSqlRecord,
  ExportedEvent,
  PreparedStatementProbeSummary,
  SoakReport,
  TamperProbeSummary,
  VerifySummary,
} from "./types.ts";
import { createWorkloadRecorder, runConcurrentWorkers } from "./workload.ts";

const APPS: readonly AppName[] = ["hono-drizzle", "prisma-api"];
const POOL_SIZE = 6;
const MAX_TIMER_SECONDS = 2_147_483;
const MAX_CONCURRENCY = 10_000;
const SUBPROCESS_TIMEOUT_MS = 30_000;
const SUBPROCESS_KILL_GRACE_MS = 2_000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const TAMPER_STATEMENTS: readonly string[] = [
  "DELETE FROM auditstream.changes",
  "UPDATE auditstream.changes SET actor = NULL",
  "INSERT INTO auditstream.changes (source, op) VALUES ('app', 'tamper.forged')",
];

interface DriverEnv {
  readonly runRoot: string;
  readonly cliBin: string;
  readonly adminUrls: Readonly<Record<AppName, string>>;
  readonly appUrls: Readonly<Record<AppName, string>>;
  readonly ports: Readonly<Record<AppName, number>>;
  readonly durationSeconds: number;
  readonly concurrency: number;
  readonly exportIntervalSeconds: number;
  readonly markdownOutPath: string;
  readonly jsonOutPath: string;
}

interface SubprocessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly aborted: boolean;
  readonly timedOut: boolean;
}

function redactCredentials(text: string): string {
  return text.replaceAll(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1***@");
}

function formatError(err: unknown): string {
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return redactCredentials(raw);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function parsePositiveEnvInt(name: string, min: number, max: number): number {
  const raw = requireEnv(name);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${raw}`);
  }
  return value;
}

function parsePortEnv(name: string): number {
  const raw = requireEnv(name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid port for ${name}: ${raw}`);
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535, got ${raw}`);
  }
  return port;
}

function loadDriverEnv(): DriverEnv {
  return {
    runRoot: requireEnv("RUN_ROOT"),
    cliBin: requireEnv("SOAK_CLI_BIN"),
    adminUrls: {
      "hono-drizzle": requireEnv("ADMIN_URL_DRIZZLE"),
      "prisma-api": requireEnv("ADMIN_URL_PRISMA"),
    },
    appUrls: {
      "hono-drizzle": requireEnv("APP_URL_DRIZZLE"),
      "prisma-api": requireEnv("APP_URL_PRISMA"),
    },
    ports: {
      "hono-drizzle": parsePortEnv("HONO_PORT"),
      "prisma-api": parsePortEnv("PRISMA_PORT"),
    },
    durationSeconds: parsePositiveEnvInt("SOAK_DURATION", 1, MAX_TIMER_SECONDS),
    concurrency: parsePositiveEnvInt("SOAK_CONCURRENCY", 2, MAX_CONCURRENCY),
    exportIntervalSeconds: parsePositiveEnvInt("SOAK_EXPORT_INTERVAL", 1, MAX_TIMER_SECONDS),
    markdownOutPath: requireEnv("SOAK_MD_OUT"),
    jsonOutPath: requireEnv("SOAK_JSON_OUT"),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function collectStream(stream: NodeJS.ReadableStream, chunks: Buffer[]): void {
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    if (bytes < MAX_CAPTURE_BYTES) {
      chunks.push(chunk);
      bytes += chunk.length;
    }
  });
}

function formatSubprocessFallback(
  aborted: boolean,
  timedOut: boolean,
  sig: NodeJS.Signals | null,
): string {
  if (aborted) {
    return "aborted";
  }
  if (timedOut) {
    return "timed out";
  }
  return sig ? `terminated by ${sig}` : "";
}

function runSubprocess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<SubprocessResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      stdout: "",
      stderr: "aborted before spawn",
      exitCode: 1,
      aborted: true,
      timedOut: false,
    });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    collectStream(proc.stdout, stdoutChunks);
    collectStream(proc.stderr, stderrChunks);

    let aborted = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (): void => {
      proc.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        proc.kill("SIGKILL");
      }, SUBPROCESS_KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    proc.once("error", (err) => {
      cleanup();
      reject(err);
    });
    proc.once("close", (code, sig) => {
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      const fallback = formatSubprocessFallback(aborted, timedOut, sig);
      resolve({
        stdout,
        stderr: redactCredentials(rawStderr.trim() || fallback),
        exitCode: code ?? 1,
        aborted,
        timedOut,
      });
    });
  });
}

function buildAuditstreamEnv(adminUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AUDITSTREAM_DATABASE_URL: adminUrl };
  delete env.AUDITSTREAM_CONFIG;
  delete env.AUDITSTREAM_SCHEMA;
  delete env.AUDITSTREAM_LOG_FORMAT;
  delete env.DATABASE_URL;
  return env;
}

async function runPsql(
  url: string,
  sql: string,
  extraArgs: readonly string[] = [],
  signal?: AbortSignal,
): Promise<SubprocessResult> {
  const parsed = new URL(url);
  const rawDb = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  const database = decodeURIComponent(rawDb);
  const args = ["-X", ...extraArgs];
  if (parsed.hostname) {
    args.push("-h", parsed.hostname);
  }
  if (parsed.port) {
    args.push("-p", parsed.port);
  }
  if (parsed.username) {
    args.push("-U", decodeURIComponent(parsed.username));
  }
  if (database) {
    args.push("-d", database);
  }
  args.push("-Atc", sql);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PGPASSWORD;
  delete env.PGPASSFILE;
  delete env.PGSERVICE;
  if (parsed.password) {
    env.PGPASSWORD = decodeURIComponent(parsed.password);
  }
  return runSubprocess("psql", args, {
    env,
    ...(signal ? { signal } : {}),
  });
}

async function queryDbUtcSince(adminUrl: string, signal?: AbortSignal): Promise<string> {
  const res = await runPsql(
    adminUrl,
    "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
    ["-v", "ON_ERROR_STOP=1"],
    signal,
  );
  if (res.exitCode !== 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(res.stdout)) {
    throw new Error(`Failed to read PostgreSQL UTC timestamp: ${res.stderr}`);
  }
  return res.stdout;
}

interface ManagedServer {
  readonly app: AppName;
  readonly proc: ChildProcess;
  readonly logs: string[];
  readonly exitPromise: Promise<void>;
  exited: boolean;
  stopping: boolean;
}

function startAppServer(env: DriverEnv, app: AppName): ManagedServer {
  const appDir = join(env.runRoot, app);
  const entry = join("dist", app, "src", "index.js");
  const proc = spawn(process.execPath, [entry], {
    cwd: appDir,
    env: {
      ...process.env,
      DATABASE_URL: env.appUrls[app],
      PORT: String(env.ports[app]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0) {
      logs.push(text);
      if (logs.length > 50) {
        logs.shift();
      }
    }
  };
  proc.stdout.on("data", capture);
  proc.stderr.on("data", capture);

  let resolveExit: (() => void) | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const server: ManagedServer = {
    app,
    proc,
    logs,
    exitPromise,
    exited: false,
    stopping: false,
  };
  const markExited = (): void => {
    if (!server.exited) {
      server.exited = true;
      resolveExit?.();
    }
  };
  proc.once("exit", markExited);
  proc.once("error", (err) => {
    logs.push(err.message);
    markExited();
  });
  return server;
}

async function waitForAppHealth(
  server: ManagedServer,
  port: number,
  signal: AbortSignal,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (signal.aborted) {
      throw new Error(`Aborted while waiting for ${server.app} health`);
    }
    if (server.exited) {
      throw new Error(`${server.app} exited before becoming healthy:\n${server.logs.join("\n")}`);
    }
    try {
      const res = await fetch(url, { signal });
      if (res.ok) {
        const body = (await res.json()) as { app?: unknown };
        if (body.app === server.app) {
          return;
        }
      }
    } catch {
      // Server still starting up.
    }
    await sleep(250, signal);
  }
  throw new Error(`Timed out waiting for ${server.app} (${url}):\n${server.logs.join("\n")}`);
}

async function stopServerGracefully(server: ManagedServer): Promise<void> {
  if (server.exited) {
    return;
  }
  if (!server.stopping) {
    server.stopping = true;
    server.proc.kill("SIGTERM");
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    killTimer = setTimeout(() => {
      if (!server.exited) {
        server.proc.kill("SIGKILL");
      }
    }, 5_000);
    await server.exitPromise;
  } finally {
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
  }
}

async function runExportOnce(
  env: DriverEnv,
  app: AppName,
  jsonlPath: string,
  cursorPath: string,
  sinceUtc: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await runSubprocess(
    env.cliBin,
    [
      "export",
      "--format",
      "jsonl",
      "--output",
      jsonlPath,
      "--cursor-file",
      cursorPath,
      "--since",
      sinceUtc,
      "--quiet",
    ],
    {
      cwd: join(env.runRoot, app),
      env: buildAuditstreamEnv(env.adminUrls[app]),
      ...(signal ? { signal } : {}),
    },
  );
  if (res.exitCode !== 0) {
    throw new Error(`auditstream export failed for ${app}: ${res.stderr}`);
  }
}

async function runTamperAttempt(
  appUrl: string,
  sql: string,
  signal?: AbortSignal,
): Promise<{
  readonly is42501: boolean;
  readonly aborted: boolean;
  readonly errorDetail: string | null;
}> {
  const res = await runPsql(appUrl, sql, ["-v", "VERBOSITY=verbose"], signal);
  if (res.aborted) {
    return { is42501: false, aborted: true, errorDetail: null };
  }
  if (res.exitCode !== 0 && /ERROR:\s+42501:/.test(res.stderr)) {
    return { is42501: true, aborted: false, errorDetail: null };
  }
  const compact = res.stderr.replaceAll(/\s+/g, " ").trim().slice(0, 160);
  return {
    is42501: false,
    aborted: false,
    errorDetail: `exit=${res.exitCode} stderr=${compact}`,
  };
}

async function probePreparedStatements(
  app: AppName,
  appUrl: string,
  signal: AbortSignal,
): Promise<PreparedStatementProbeSummary> {
  const sql =
    "SELECT pg_backend_pid() || '|' || (SELECT count(*) FROM pg_prepared_statements WHERE statement LIKE '%auditstream=%') FROM pg_sleep(1.5)";
  const probes = Array.from({ length: POOL_SIZE }, () =>
    runPsql(appUrl, sql, ["-v", "ON_ERROR_STOP=1"], signal),
  );
  const results = await Promise.all(probes);
  const backendPids = new Set<string>();
  let leakedCount = 0;

  for (const res of results) {
    if (res.exitCode !== 0 || !res.stdout.includes("|")) {
      throw new Error(`Prepared statement probe failed on ${app}: ${res.stderr}`);
    }
    const [pid, countRaw] = res.stdout.split("|");
    if (pid) {
      backendPids.add(pid);
    }
    leakedCount += Number.parseInt(countRaw ?? "0", 10);
  }
  return {
    app,
    distinctBackends: backendPids.size,
    expectedBackends: POOL_SIZE,
    leakedCount,
  };
}

async function runFinalVerify(
  env: DriverEnv,
  app: AppName,
  signal: AbortSignal,
): Promise<VerifySummary> {
  const res = await runSubprocess(env.cliBin, ["verify", "--format", "json"], {
    cwd: join(env.runRoot, app),
    env: buildAuditstreamEnv(env.adminUrls[app]),
    signal,
  });
  if (res.aborted || signal.aborted) {
    throw new Error(`auditstream verify aborted for ${app}`);
  }
  try {
    const parsed = JSON.parse(res.stdout || "{}") as { ok?: unknown; findings?: unknown[] };
    return {
      app,
      ok: res.exitCode === 0 && parsed.ok === true,
      findingsCount: Array.isArray(parsed.findings) ? parsed.findings.length : 1,
    };
  } catch {
    return { app, ok: false, findingsCount: 1 };
  }
}

function parseJsonlFile(filePath: string): {
  readonly events: ExportedEvent[];
  readonly parseErrors: number;
} {
  try {
    return parseJsonlContent(readFileSync(filePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], parseErrors: 0 };
    }
    throw err;
  }
}

interface SidecarState {
  readonly directSqlWrites: DirectSqlRecord[];
  readonly tamperErrors: string[];
  tamperAttempts: number;
  tamperRejected: number;
}

async function runSqlSidecarForApp(
  env: DriverEnv,
  app: AppName,
  runId: string,
  tick: number,
  state: SidecarState,
  hardAbortSignal: AbortSignal,
): Promise<void> {
  for (const tamperSql of TAMPER_STATEMENTS) {
    if (hardAbortSignal.aborted) {
      return;
    }
    const tamperRes = await runTamperAttempt(env.appUrls[app], tamperSql, hardAbortSignal);
    if (tamperRes.aborted) {
      return;
    }
    state.tamperAttempts += 1;
    if (tamperRes.is42501) {
      state.tamperRejected += 1;
    } else if (tamperRes.errorDetail) {
      state.tamperErrors.push(`${app}:${tamperRes.errorDetail}`);
    }
  }

  const markerStatus = `direct_sql_${runId}_${app === "hono-drizzle" ? "h" : "p"}_${tick}`;
  const directRes = await runPsql(
    env.appUrls[app],
    `INSERT INTO public.invoice (status, total) VALUES ('${markerStatus}', '1.00')`,
    ["-v", "ON_ERROR_STOP=1"],
    hardAbortSignal,
  );
  if (directRes.aborted) {
    return;
  }
  if (directRes.exitCode !== 0) {
    throw new Error(`Direct SQL write failed on ${app}: ${directRes.stderr}`);
  }
  state.directSqlWrites.push({ app, markerStatus });
}

async function runSqlSidecarTick(
  env: DriverEnv,
  runId: string,
  tick: number,
  state: SidecarState,
  hardAbortSignal: AbortSignal,
): Promise<void> {
  for (const app of APPS) {
    if (hardAbortSignal.aborted) {
      return;
    }
    await runSqlSidecarForApp(env, app, runId, tick, state, hardAbortSignal);
  }
}

interface ExportLoopOptions {
  readonly env: DriverEnv;
  readonly app: AppName;
  readonly jsonlPath: string;
  readonly cursorPath: string;
  readonly sinceUtc: string;
  readonly exportCycles: Record<AppName, number>;
  readonly gracefulStopSignal: AbortSignal;
  readonly hardAbortSignal: AbortSignal;
}

async function runExportLoop(opts: ExportLoopOptions): Promise<void> {
  while (!opts.gracefulStopSignal.aborted && !opts.hardAbortSignal.aborted) {
    await sleep(opts.env.exportIntervalSeconds * 1000, opts.gracefulStopSignal);
    if (opts.gracefulStopSignal.aborted || opts.hardAbortSignal.aborted) {
      break;
    }
    await runExportOnce(
      opts.env,
      opts.app,
      opts.jsonlPath,
      opts.cursorPath,
      opts.sinceUtc,
      opts.hardAbortSignal,
    );
    opts.exportCycles[opts.app] += 1;
  }
}

async function runSqlSidecarLoop(
  env: DriverEnv,
  runId: string,
  sidecar: SidecarState,
  gracefulStopSignal: AbortSignal,
  hardAbortSignal: AbortSignal,
): Promise<void> {
  let tick = 1;
  await runSqlSidecarTick(env, runId, tick, sidecar, hardAbortSignal);
  while (!gracefulStopSignal.aborted && !hardAbortSignal.aborted) {
    await sleep(1_500, gracefulStopSignal);
    if (gracefulStopSignal.aborted || hardAbortSignal.aborted) {
      break;
    }
    tick += 1;
    await runSqlSidecarTick(env, runId, tick, sidecar, hardAbortSignal);
  }
}

async function drainFinalExports(
  env: DriverEnv,
  jsonlPaths: Readonly<Record<AppName, string>>,
  cursorPaths: Readonly<Record<AppName, string>>,
  sinceByApp: Readonly<Record<AppName, string>>,
  exportCycles: Record<AppName, number>,
  signal: AbortSignal,
): Promise<void> {
  for (const pass of [1, 2]) {
    if (pass === 2) {
      await sleep(150, signal);
    }
    for (const app of APPS) {
      await runExportOnce(env, app, jsonlPaths[app], cursorPaths[app], sinceByApp[app], signal);
      exportCycles[app] += 1;
    }
  }
}

interface SoakPhaseResult {
  readonly elapsedMs: number;
  readonly recorder: ReturnType<typeof createWorkloadRecorder>;
  readonly exportCycles: Record<AppName, number>;
  readonly sidecar: SidecarState;
}

async function runSoakPhase(
  env: DriverEnv,
  runId: string,
  jsonlPaths: Readonly<Record<AppName, string>>,
  cursorPaths: Readonly<Record<AppName, string>>,
  sinceByApp: Readonly<Record<AppName, string>>,
  shutdownSignal: AbortSignal,
): Promise<SoakPhaseResult> {
  const recorder = createWorkloadRecorder();
  const exportCycles: Record<AppName, number> = { "hono-drizzle": 0, "prisma-api": 0 };
  const sidecar: SidecarState = {
    directSqlWrites: [],
    tamperErrors: [],
    tamperAttempts: 0,
    tamperRejected: 0,
  };

  // Separate gracefulStop (wakes idle sleep when workers finish so in-flight ticks complete
  // cleanly) from hardAbort (terminates active subprocesses on SIGINT/SIGTERM or fatal errors).
  const gracefulStop = new AbortController();
  const hardAbort = new AbortController();
  const onShutdown = (): void => {
    gracefulStop.abort();
    hardAbort.abort();
  };
  if (shutdownSignal.aborted) {
    onShutdown();
  } else {
    shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  }

  let backgroundError: unknown = null;
  const captureBgError = (err: unknown): void => {
    if (!hardAbort.signal.aborted && backgroundError === null) {
      backgroundError = err;
      gracefulStop.abort();
      hardAbort.abort();
    }
  };

  const exportLoops = APPS.map((app) =>
    runExportLoop({
      env,
      app,
      jsonlPath: jsonlPaths[app],
      cursorPath: cursorPaths[app],
      sinceUtc: sinceByApp[app],
      exportCycles,
      gracefulStopSignal: gracefulStop.signal,
      hardAbortSignal: hardAbort.signal,
    }).catch(captureBgError),
  );
  const sqlLoop = runSqlSidecarLoop(
    env,
    runId,
    sidecar,
    gracefulStop.signal,
    hardAbort.signal,
  ).catch(captureBgError);

  const startTimeMs = Date.now();
  try {
    await runConcurrentWorkers({
      runId,
      honoBaseUrl: `http://127.0.0.1:${env.ports["hono-drizzle"]}`,
      prismaBaseUrl: `http://127.0.0.1:${env.ports["prisma-api"]}`,
      concurrency: env.concurrency,
      durationSeconds: env.durationSeconds,
      recorder,
      signal: hardAbort.signal,
    });
  } catch (err) {
    hardAbort.abort();
    throw err;
  } finally {
    gracefulStop.abort();
    await Promise.allSettled([...exportLoops, sqlLoop]);
    shutdownSignal.removeEventListener("abort", onShutdown);
  }

  if (backgroundError !== null) {
    throw backgroundError;
  }

  return { elapsedMs: Date.now() - startTimeMs, recorder, exportCycles, sidecar };
}

async function runSettledOrAbort<T>(
  tasks: readonly Promise<T>[],
  onFailure: () => void,
): Promise<T[]> {
  const settled = await Promise.allSettled(
    tasks.map((task) =>
      task.catch((err: unknown) => {
        onFailure();
        throw err;
      }),
    ),
  );
  const values: T[] = [];
  let firstError: unknown;
  let hasError = false;
  for (const entry of settled) {
    if (entry.status === "fulfilled") {
      values.push(entry.value);
    } else if (!hasError) {
      hasError = true;
      firstError = entry.reason;
    }
  }
  if (hasError) {
    throw firstError;
  }
  return values;
}

function writeReports(env: DriverEnv, report: SoakReport): void {
  const markdown = formatMarkdownReport(report);
  mkdirSync(dirname(env.markdownOutPath), { recursive: true });
  mkdirSync(dirname(env.jsonOutPath), { recursive: true });
  writeFileSync(env.markdownOutPath, markdown, "utf8");
  writeFileSync(env.jsonOutPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(markdown);
  console.error(
    `Reports written:\n  - Markdown: ${env.markdownOutPath}\n  - JSON:     ${env.jsonOutPath}`,
  );
}

async function main(): Promise<void> {
  const env = loadDriverEnv();
  const runId = randomBytes(4).toString("hex");
  const workDir = mkdtempSync(join(tmpdir(), `auditstream-soak-${runId}-`));
  const servers: ManagedServer[] = [];
  const shutdownController = new AbortController();
  let signalExitCode: number | null = null;
  let cleanupPromise: Promise<void> | null = null;

  const cleanupAll = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      shutdownController.abort();
      await Promise.all(servers.map((s) => stopServerGracefully(s)));
      rmSync(workDir, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };

  const onSignal = (code: number): void => {
    if (signalExitCode === null) {
      signalExitCode = code;
      shutdownController.abort();
    }
  };
  process.once("SIGINT", () => onSignal(130));
  process.once("SIGTERM", () => onSignal(143));

  try {
    console.error(
      `==> Starting soak run ${runId} (duration=${env.durationSeconds}s, concurrency=${env.concurrency}, export_interval=${env.exportIntervalSeconds}s)...`,
    );

    for (const app of APPS) {
      servers.push(startAppServer(env, app));
    }
    await runSettledOrAbort(
      servers.map((s) => waitForAppHealth(s, env.ports[s.app], shutdownController.signal)),
      () => shutdownController.abort(),
    );

    const sinceByApp: Record<AppName, string> = {
      "hono-drizzle": await queryDbUtcSince(
        env.adminUrls["hono-drizzle"],
        shutdownController.signal,
      ),
      "prisma-api": await queryDbUtcSince(env.adminUrls["prisma-api"], shutdownController.signal),
    };
    const jsonlPaths: Record<AppName, string> = {
      "hono-drizzle": join(workDir, "hono-drizzle.jsonl"),
      "prisma-api": join(workDir, "prisma-api.jsonl"),
    };
    const cursorPaths: Record<AppName, string> = {
      "hono-drizzle": join(workDir, "hono-drizzle.cursor"),
      "prisma-api": join(workDir, "prisma-api.cursor"),
    };

    const phase = await runSoakPhase(
      env,
      runId,
      jsonlPaths,
      cursorPaths,
      sinceByApp,
      shutdownController.signal,
    );
    if (signalExitCode !== null) {
      process.exitCode = signalExitCode;
      return;
    }

    console.error("==> Probing pooled PgBouncer sessions for prepared-statement leaks...");
    const preparedStatements = await runSettledOrAbort(
      APPS.map((app) => probePreparedStatements(app, env.appUrls[app], shutdownController.signal)),
      () => shutdownController.abort(),
    );

    console.error("==> Stopping HTTP servers and running final auditstream export drain...");
    await Promise.all(servers.map((s) => stopServerGracefully(s)));
    await drainFinalExports(
      env,
      jsonlPaths,
      cursorPaths,
      sinceByApp,
      phase.exportCycles,
      shutdownController.signal,
    );

    console.error("==> Running final auditstream verify on both databases...");
    const verifyResults = await runSettledOrAbort(
      APPS.map((app) => runFinalVerify(env, app, shutdownController.signal)),
      () => shutdownController.abort(),
    );
    if (signalExitCode !== null) {
      process.exitCode = signalExitCode;
      return;
    }

    const parsedHono = parseJsonlFile(jsonlPaths["hono-drizzle"]);
    const parsedPrisma = parseJsonlFile(jsonlPaths["prisma-api"]);
    const tamper: TamperProbeSummary = {
      attempts: phase.sidecar.tamperAttempts,
      rejected42501: phase.sidecar.tamperRejected,
      unexpectedErrors: phase.sidecar.tamperErrors,
    };

    const report = evaluateOracle({
      metrics: {
        runId,
        durationSeconds: env.durationSeconds,
        elapsedMs: phase.elapsedMs,
        concurrency: env.concurrency,
        totalRequests: phase.recorder.totalRequests,
        http5xxCount: phase.recorder.http5xxCount,
        unexpectedHttpCount: phase.recorder.unexpectedHttpCount,
        unexpectedHttpSamples: phase.recorder.unexpectedHttpSamples,
        activityReads: phase.recorder.activityReads,
        exportCycles: phase.exportCycles,
        latenciesMs: phase.recorder.latenciesMs,
      },
      expectedMutations: phase.recorder.expectedMutations,
      abortedRequests: phase.recorder.abortedRequests,
      forbiddenRequests: phase.recorder.forbiddenRequests,
      directSqlWrites: phase.sidecar.directSqlWrites,
      exportedByApp: {
        "hono-drizzle": parsedHono.events,
        "prisma-api": parsedPrisma.events,
      },
      parseErrorsByApp: {
        "hono-drizzle": parsedHono.parseErrors,
        "prisma-api": parsedPrisma.parseErrors,
      },
      tamper,
      preparedStatements,
      verifyResults,
    });

    writeReports(env, report);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } catch (err) {
    if (signalExitCode !== null) {
      process.exitCode = signalExitCode;
      return;
    }
    throw err;
  } finally {
    await cleanupAll();
  }
}

try {
  await main();
} catch (err) {
  console.error("Soak run failed:", formatError(err));
  process.exitCode = 1;
}
