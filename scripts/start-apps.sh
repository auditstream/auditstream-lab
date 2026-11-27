#!/usr/bin/env bash
# Starts both bootstrapped HTTP apps connected through PgBouncer as least-privilege app_user.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

require_cmd node
require_cmd curl

HONO_ENTRY="${RUN_ROOT}/hono-drizzle/dist/hono-drizzle/src/index.js"
PRISMA_ENTRY="${RUN_ROOT}/prisma-api/dist/prisma-api/src/index.js"

if [[ ! -f "${RUN_ROOT}/cli-bin.path" || ! -f "$HONO_ENTRY" || ! -f "$PRISMA_ENTRY" ]]; then
  echo "ERROR: lab apps are not completely bootstrapped yet. Run ./scripts/bootstrap.sh first." >&2
  exit 1
fi

ensure_distinct_ports "$HONO_PORT" "$PRISMA_PORT"
ensure_port_free "hono-drizzle" "$HONO_PORT"
ensure_port_free "prisma-api" "$PRISMA_PORT"

HONO_PID=""
PRISMA_PID=""

cleanup() {
  stop_pid "$HONO_PID"
  stop_pid "$PRISMA_PID"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

# Launch Node directly (rather than through `pnpm run`) so SIGTERM reaches Node's
# graceful shutdown handler directly and wait reaps the actual server process.
(
  cd "${RUN_ROOT}/hono-drizzle"
  DATABASE_URL="$APP_URL_DRIZZLE" PORT="$HONO_PORT" exec node dist/hono-drizzle/src/index.js
) &
HONO_PID=$!

(
  cd "${RUN_ROOT}/prisma-api"
  DATABASE_URL="$APP_URL_PRISMA" PORT="$PRISMA_PORT" exec node dist/prisma-api/src/index.js
) &
PRISMA_PID=$!

wait_for_http "hono-drizzle" "http://127.0.0.1:${HONO_PORT}/health" "$HONO_PID"
wait_for_http "prisma-api" "http://127.0.0.1:${PRISMA_PORT}/health" "$PRISMA_PID"

echo ""
echo "Interactive lab servers are running (connected via PgBouncer 127.0.0.1:${PGBOUNCER_PORT} as app_user):"
echo "  - hono-drizzle: http://127.0.0.1:${HONO_PORT}"
echo "  - prisma-api:   http://127.0.0.1:${PRISMA_PORT}"
echo "Press Ctrl+C to stop both servers."

# Portable (Bash 3.2+) supervisor loop: exit immediately if either server terminates,
# preserving its exit status and letting the EXIT trap shut down the surviving server.
while kill -0 "$HONO_PID" 2>/dev/null && kill -0 "$PRISMA_PID" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$HONO_PID" 2>/dev/null; then
  wait "$HONO_PID"
else
  wait "$PRISMA_PID"
fi
