#!/usr/bin/env bash
# Runs the concurrent HTTP + SQL soak generator and invariant oracle against both
# bootstrapped lab apps (hono-drizzle and prisma-api) via PgBouncer 1.26 while executing
# incremental `auditstream export --cursor-file` in parallel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LAB_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

DURATION=120
CONCURRENCY=40
EXPORT_INTERVAL=2
MD_OUT="${LAB_ROOT}/.tmp/soak/soak-report.md"
JSON_OUT=""

usage() {
  cat <<'EOUSAGE'
Usage: ./soak/run.sh [OPTIONS]

Options:
  --duration <seconds>         Soak duration in seconds (default: 120)
  --concurrency <workers>      Total concurrent HTTP workers across both apps (default: 40, min: 2)
  --export-interval <seconds>  Parallel auditstream export interval in seconds (default: 2)
  --out <path>                 Markdown report output path (default: .tmp/soak/soak-report.md)
  --json-out <path>            Structured JSON report output path (default: derived from --out)
  -h, --help                   Show this help message
EOUSAGE
}

require_arg_value() {
  local flag="$1"
  local remaining="$2"
  local val="${3:-}"
  if [[ "$remaining" -lt 2 || -z "$val" ]]; then
    echo "ERROR: ${flag} requires a non-empty value" >&2
    exit 2
  fi
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --duration)
      require_arg_value "$1" "$#" "${2:-}"
      DURATION="$2"
      shift 2
      ;;
    --concurrency)
      require_arg_value "$1" "$#" "${2:-}"
      CONCURRENCY="$2"
      shift 2
      ;;
    --export-interval)
      require_arg_value "$1" "$#" "${2:-}"
      EXPORT_INTERVAL="$2"
      shift 2
      ;;
    --out)
      require_arg_value "$1" "$#" "${2:-}"
      MD_OUT="$2"
      shift 2
      ;;
    --json-out)
      require_arg_value "$1" "$#" "${2:-}"
      JSON_OUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

validate_int_range() {
  local name="$1"
  local val="$2"
  local min="$3"
  local max="$4"
  if [[ ! "$val" =~ ^[1-9][0-9]*$ ]] || (( ${#val} > 9 )) || (( 10#$val < min || 10#$val > max )); then
    echo "ERROR: ${name} must be a base-10 integer between ${min} and ${max} (got '${val}')" >&2
    exit 2
  fi
}

validate_output_arg() {
  local flag="$1"
  local raw="$2"
  if [[ "$raw" == */ || "$raw" == "." || "$raw" == ".." || "$raw" == */. || "$raw" == */.. ]]; then
    echo "ERROR: ${flag} must be a file path, not a directory (got '${raw}')" >&2
    exit 2
  fi
}

validate_int_range "--duration" "$DURATION" 1 2147483
validate_int_range "--concurrency" "$CONCURRENCY" 2 10000
validate_int_range "--export-interval" "$EXPORT_INTERVAL" 1 2147483
validate_output_arg "--out" "$MD_OUT"

if [[ -z "$JSON_OUT" ]]; then
  if [[ "$MD_OUT" == *.md ]]; then
    JSON_OUT="${MD_OUT%.md}.json"
  else
    JSON_OUT="${MD_OUT}.json"
  fi
fi
validate_output_arg "--json-out" "$JSON_OUT"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: required command 'node' not found in PATH" >&2
  exit 1
fi

canonicalize_path() {
  node --input-type=module -e '
import { readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

const raw = process.argv[1];
let cur = isAbsolute(raw) ? sep : realpathSync(process.cwd());
const queue = raw.split(sep).filter((p) => p.length > 0 && p !== ".");
let hops = 0;

while (queue.length > 0) {
  const part = queue.shift();
  if (part === "..") {
    const idx = cur.lastIndexOf(sep);
    cur = idx <= 0 ? sep : cur.slice(0, idx);
    continue;
  }
  const next = cur === sep ? sep + part : cur + sep + part;
  try {
    const target = readlinkSync(next);
    hops += 1;
    if (hops > 40) {
      throw new Error("Too many symlink hops while resolving " + raw);
    }
    if (isAbsolute(target)) {
      cur = sep;
    }
    queue.unshift(...target.split(sep).filter((p) => p.length > 0 && p !== "."));
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EINVAL" || err.code === "ENOTDIR")) {
      cur = next;
    } else {
      throw err;
    }
  }
}
process.stdout.write(cur);
' -- "$1"
}

MD_OUT_RESOLVED="$(canonicalize_path "$MD_OUT")"
JSON_OUT_RESOLVED="$(canonicalize_path "$JSON_OUT")"

if [[ -d "$MD_OUT_RESOLVED" ]]; then
  echo "ERROR: --out points to an existing directory: '${MD_OUT_RESOLVED}'" >&2
  exit 2
fi

if [[ -d "$JSON_OUT_RESOLVED" ]]; then
  echo "ERROR: --json-out points to an existing directory: '${JSON_OUT_RESOLVED}'" >&2
  exit 2
fi

if [[ "$MD_OUT_RESOLVED" == "$JSON_OUT_RESOLVED" ]]; then
  echo "ERROR: --out and --json-out must resolve to distinct file paths (got '${MD_OUT_RESOLVED}')" >&2
  exit 2
fi

# Source shared lab helpers/config only after CLI flags are validated so --help and usage errors
# remain independent of local .env values.
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/../scripts/common.sh"

require_cmd psql

HONO_ENTRY="${RUN_ROOT}/hono-drizzle/dist/hono-drizzle/src/index.js"
PRISMA_ENTRY="${RUN_ROOT}/prisma-api/dist/prisma-api/src/index.js"

if [[ ! -f "${RUN_ROOT}/cli-bin.path" || ! -f "$HONO_ENTRY" || ! -f "$PRISMA_ENTRY" ]]; then
  echo "ERROR: lab apps are not completely bootstrapped yet. Run ./scripts/bootstrap.sh first." >&2
  exit 1
fi

if [[ -n "${AUDITSTREAM_BIN:-}" || -n "${AUDITSTREAM_VERSION:-}" || "${AUDITSTREAM_FORCE_DOWNLOAD:-0}" == "1" ]]; then
  CLI_BIN="$(resolve_auditstream_bin)"
else
  CLI_BIN="$(cat "${RUN_ROOT}/cli-bin.path")"
fi

if [[ ! -f "$CLI_BIN" || ! -x "$CLI_BIN" ]]; then
  echo "ERROR: resolved auditstream CLI is not an executable file: ${CLI_BIN}" >&2
  exit 1
fi

ensure_distinct_ports "$HONO_PORT" "$PRISMA_PORT"
ensure_port_free "hono-drizzle" "$HONO_PORT"
ensure_port_free "prisma-api" "$PRISMA_PORT"

wait_for_sql "PostgreSQL (lab_drizzle)" "$ADMIN_URL_DRIZZLE"
wait_for_sql "PostgreSQL (lab_prisma)" "$ADMIN_URL_PRISMA"
wait_for_sql "PgBouncer (lab_drizzle)" "$APP_URL_DRIZZLE"
wait_for_sql "PgBouncer (lab_prisma)" "$APP_URL_PRISMA"

export SOAK_CLI_BIN="$CLI_BIN"
export SOAK_DURATION="$DURATION"
export SOAK_CONCURRENCY="$CONCURRENCY"
export SOAK_EXPORT_INTERVAL="$EXPORT_INTERVAL"
export SOAK_MD_OUT="$MD_OUT_RESOLVED"
export SOAK_JSON_OUT="$JSON_OUT_RESOLVED"

if node "${LAB_ROOT}/soak/types.ts" >/dev/null 2>&1; then
  exec node "${LAB_ROOT}/soak/driver.ts"
else
  exec node --experimental-strip-types "${LAB_ROOT}/soak/driver.ts"
fi
