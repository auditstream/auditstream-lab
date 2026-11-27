#!/usr/bin/env bash
# Automated end-to-end verification of the interactive lab stack:
#   - starts both bootstrapped HTTP apps via PgBouncer as least-privilege app_user
#   - verifies strict HTTP validation (400/404, AuditstreamError) and numeric(12,2) serialization
#   - exercises human, excluded-column no-op (including passwordHash: null), delegated AI agent,
#     committed + rolled-back nested SAVEPOINT, full rollback, raw SQL, Prisma comments +
#     auditTransaction (set_config), audit.log(), and paginated/filtered allowlisted /activity
#   - proves tamper resistance (app_user DELETE/UPDATE/INSERT denied on auditstream.changes)
#   - probes all 6 pooled PgBouncer backend sessions (verified by 6 distinct pg_backend_pid values)
#     for auditstream= prepared-statement leaks
#   - runs live auditstream status, verify, history (--diff when supported + --format json),
#     and export --format jsonl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

require_cmd node
require_cmd curl
require_cmd jq
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

TMP_DIR="$(mktemp -d)"
HONO_LOG="${TMP_DIR}/hono.log"
PRISMA_LOG="${TMP_DIR}/prisma.log"
HONO_PID=""
PRISMA_PID=""
PROBE_PIDS=""
HTTP_BODY=""
HTTP_STATUS=""

cleanup() {
  local exit_code=$?
  local p
  for p in $PROBE_PIDS; do
    stop_pid "$p"
  done
  stop_pid "$HONO_PID"
  stop_pid "$PRISMA_PID"
  if [[ "$exit_code" -ne 0 ]]; then
    echo "--- hono-drizzle log ---" >&2
    cat "$HONO_LOG" >&2 || true
    echo "--- prisma-api log ---" >&2
    cat "$PRISMA_LOG" >&2 || true
  fi
  rm -rf "$TMP_DIR"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "${label}: expected '${expected}', got '${actual}'"
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "${label}: expected output to contain '${needle}'"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    fail "${label}: unexpected secret or disallowed token '${needle}' found"
  fi
}

# Sends an HTTP request, asserts the status code, and stores response text in HTTP_BODY.
# Uses ${1+"$@"} for Bash 3.2 set -u compatibility when no extra curl flags are passed.
http_json() {
  local method="$1"
  local url="$2"
  local expected_status="$3"
  shift 3

  local resp_file="${TMP_DIR}/resp.json"
  HTTP_STATUS="$(curl -sS -o "$resp_file" -w '%{http_code}' -X "$method" ${1+"$@"} "$url")"
  HTTP_BODY="$(cat "$resp_file")"
  if [[ "$HTTP_STATUS" != "$expected_status" ]]; then
    fail "${method} ${url} returned HTTP ${HTTP_STATUS} (expected ${expected_status}): ${HTTP_BODY}"
  fi
}

run_cli() {
  local app_dir="$1"
  local admin_url="$2"
  shift 2
  (
    cd "$app_dir"
    "$CLI_BIN" --database-url "$admin_url" ${1+"$@"}
  )
}

assert_http_error_contracts() {
  local label="$1"
  local base_url="$2"

  http_json POST "${base_url}/invoices" 400 \
    -H "content-type: application/json" \
    -d '{invalid-json'
  http_json POST "${base_url}/invoices" 400 \
    -H "content-type: application/json" \
    -d '{"status":"draft","total":50}'
  http_json POST "${base_url}/invoices" 400 \
    -H "content-type: application/json" \
    -d '{"status":123}'
  http_json PATCH "${base_url}/invoices/2147483648" 400 \
    -H "content-type: application/json" \
    -d '{"status":"paid"}'
  http_json DELETE "${base_url}/invoices/999999" 404
  http_json GET "${base_url}/activity?cursor=invalid-cursor" 400
  http_json POST "${base_url}/invoices/1/events" 400 \
    -H "content-type: application/json" \
    -H "x-demo-user: alice" \
    -d '{"action":"INSERT"}'
  echo "  - ${label}: HTTP 400/404 and AuditstreamError contracts verified"
}

assert_tamper_denied() {
  local label="$1"
  local app_url="$2"
  local err_file="${TMP_DIR}/tamper_${label}.err"
  psql -X "$app_url" -q >/dev/null 2>"$err_file" <<'EOSQL' || true
DELETE FROM auditstream.changes;
UPDATE auditstream.changes SET actor = NULL;
INSERT INTO auditstream.changes (op) VALUES ('FORGED');
EOSQL

  local denied_count unexpected
  denied_count="$(grep -c "permission denied" "$err_file" || true)"
  if [[ "$denied_count" != "3" ]]; then
    cat "$err_file" >&2
    fail "${label} tamper denials: expected '3', got '${denied_count}'"
  fi

  unexpected="$(grep "ERROR:" "$err_file" | grep -v "permission denied" || true)"
  if [[ -n "$unexpected" ]]; then
    fail "${label} unexpected SQL errors during tamper check: ${unexpected}"
  fi
}

# Probes all 6 PgBouncer backend connections in the (db, app_user) pool (DEFAULT_POOL_SIZE=6)
# using a single-statement SELECT (compatible with psql <= 14 and >= 15) with a 1.5s hold so
# all 6 cold/warm backends overlap reliably, and asserts 6 distinct pg_backend_pid() values
# with zero auditstream= prepared statements.
assert_no_prepared_statement_leak() {
  local label="$1"
  local app_url="$2"
  local i p
  PROBE_PIDS=""

  for i in 1 2 3 4 5 6; do
    psql -X "$app_url" -v ON_ERROR_STOP=1 -Atc \
      "SELECT pg_backend_pid() || '|' || (SELECT count(*) FROM pg_prepared_statements WHERE statement LIKE '%auditstream=%') FROM pg_sleep(1.5)" \
      > "${TMP_DIR}/prep_${label}_${i}.txt" &
    PROBE_PIDS="${PROBE_PIDS} $!"
  done

  for p in $PROBE_PIDS; do
    wait "$p" || fail "${label} pooled pg_prepared_statements probe failed"
  done
  PROBE_PIDS=""

  local pid_file="${TMP_DIR}/prep_pids_${label}.txt"
  : > "$pid_file"
  local line leaked_count=0 distinct_backends=0
  for i in 1 2 3 4 5 6; do
    line="$(grep '|' "${TMP_DIR}/prep_${label}_${i}.txt" | tail -n 1 || true)"
    [[ -n "$line" ]] || fail "${label} prepared statement probe ${i} returned no row"
    printf '%s\n' "${line%%|*}" >> "$pid_file"
    leaked_count=$((leaked_count + ${line##*|}))
  done

  distinct_backends="$(sort -u "$pid_file" | wc -l | tr -d '[:space:]')"
  assert_eq "$distinct_backends" "6" "${label} distinct pooled pg_backend_pid count"
  assert_eq "$leaked_count" "0" "${label} pooled pg_prepared_statements auditstream comment leak"
}

assert_no_secret_in_db() {
  local label="$1"
  local admin_url="$2"
  local leaked
  leaked="$(psql -X "$admin_url" -Atc "SELECT count(*) FROM auditstream.changes WHERE before::text LIKE '%secret-%' OR after::text LIKE '%secret-%' OR changed::text LIKE '%password_hash%'")"
  assert_eq "$leaked" "0" "${label} excluded column leakage in auditstream.changes"
}

assert_activity_feed() {
  local label="$1"
  local base_url="$2"
  local invoice_id="$3"
  local expected_obo="$4"

  http_json GET "${base_url}/activity?limit=20" 200
  jq -e --arg inv "$invoice_id" \
    'any(.items[]; .source == "db" and .entity == "invoice" and .recordId == $inv and .action == "UPDATE" and (.changedFields | index("status") != null) and (.changedFields | index("password_hash") == null))' \
    <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity missing scoped db UPDATE with status changedFields: ${HTTP_BODY}"
  jq -e --arg inv "$invoice_id" \
    'any(.items[]; .source == "app" and .action == "invoice.exported" and .recordId == $inv)' \
    <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity missing scoped app event: ${HTTP_BODY}"
  jq -e --arg inv "$invoice_id" --arg obo "$expected_obo" \
    'any(.items[]; .recordId == $inv and .actor.onBehalfOf.id? == $obo)' \
    <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity missing scoped delegated onBehalfOf=${expected_obo}: ${HTTP_BODY}"
  jq -e 'all(.items[]; (keys - ["eventId","occurredAt","source","action","entity","recordId","changedFields","actor"]) | length == 0)' \
    <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity leaked non-allowlisted top-level keys: ${HTTP_BODY}"
  assert_not_contains "$HTTP_BODY" "password_hash" "${label} /activity"
  assert_not_contains "$HTTP_BODY" "passwordHash" "${label} /activity"
  assert_not_contains "$HTTP_BODY" "secret-" "${label} /activity"
  assert_not_contains "$HTTP_BODY" "actor_source" "${label} /activity"

  # Verify keyset pagination (limit=1 -> follow nextCursor) and query filters.
  http_json GET "${base_url}/activity?limit=1" 200
  local first_event_id next_cursor
  first_event_id="$(jq -r '.items[0].eventId // empty' <<<"$HTTP_BODY")"
  next_cursor="$(jq -r '.nextCursor // empty' <<<"$HTTP_BODY")"
  jq -e '.hasMore == true and (.nextCursor | type == "string" and length > 0)' <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity?limit=1 missing pagination cursor: ${HTTP_BODY}"

  http_json GET "${base_url}/activity?limit=1&cursor=${next_cursor}" 200
  jq -e --arg first "$first_event_id" '(.items | length == 1) and .items[0].eventId != $first' <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity cursor pagination did not advance: ${HTTP_BODY}"

  http_json GET "${base_url}/activity?source=app&limit=10" 200
  jq -e '(.items | length >= 1) and all(.items[]; .source == "app")' <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity?source=app filter failed: ${HTTP_BODY}"

  http_json GET "${base_url}/activity?table=invoice&limit=10" 200
  jq -e '(.items | length >= 1) and all(.items[]; .entity == "invoice")' <<<"$HTTP_BODY" >/dev/null \
    || fail "${label} /activity?table=invoice filter failed: ${HTTP_BODY}"
}

verify_cli_outputs() {
  local label="$1"
  local app_dir="$2"
  local admin_url="$3"
  local invoice_id="$4"
  local expected_agent="$5"
  local expected_new_status="$6"
  local expected_update_source="$7"
  local expected_req_id="$8"

  local status_json verify_json history_out history_json export_jsonl has_diff=0
  status_json="$(run_cli "$app_dir" "$admin_url" status --format json)"
  jq -e '.problems_found == 0 and any(.tables[]; .table == "public.invoice" and .captured == true and (.excluded_columns | index("password_hash") != null)) and any(.tables[]; .table == "public.line_item" and .captured == true)' <<<"$status_json" >/dev/null \
    || fail "${label} auditstream status check failed: ${status_json}"

  verify_json="$(run_cli "$app_dir" "$admin_url" verify --format json)"
  jq -e '.ok == true and (.findings | length == 0)' <<<"$verify_json" >/dev/null \
    || fail "${label} auditstream verify check failed: ${verify_json}"

  if "$CLI_BIN" history --help | grep -q -- '--diff'; then
    has_diff=1
    history_out="$(run_cli "$app_dir" "$admin_url" history --table public.invoice --record-id "$invoice_id" --diff)"
    assert_contains "$history_out" "~ status: \"draft\" -> \"${expected_new_status}\"" "${label} history --diff status change"
  else
    history_out="$(run_cli "$app_dir" "$admin_url" history --table public.invoice --record-id "$invoice_id")"
  fi
  assert_contains "$history_out" "ai_agent:${expected_agent} for user:alice" "${label} history delegated actor"
  # Ensure a standalone human actor line exists (not merely the substring inside `for user:alice`).
  grep -Eq '(^|[[:space:]])user:alice([[:space:]]|$)' <<<"$(grep -v 'for user:alice' <<<"$history_out")" \
    || fail "${label} history missing standalone human actor user:alice: ${history_out}"
  assert_not_contains "$history_out" "password_hash" "${label} history"
  assert_not_contains "$history_out" "secret-" "${label} history"

  history_json="$(run_cli "$app_dir" "$admin_url" history --table public.invoice --record-id "$invoice_id" --format json)"
  jq -se \
    --arg agent "$expected_agent" \
    --arg next_status "$expected_new_status" \
    --arg upd_src "$expected_update_source" \
    --arg req_id "$expected_req_id" \
    '
      any(.[]; .op == "INSERT" and .actor.type? == "user" and .actor.id? == "alice" and .actor.tenant? == "acme" and .actor_source == "comment" and .context.requestId? == $req_id) and
      any(.[]; .op == "UPDATE" and .before.status? == "draft" and .after.status? == $next_status and .actor.type? == "ai_agent" and .actor.id? == $agent and .actor.onBehalfOf.id? == "alice" and .actor_source == $upd_src) and
      any(.[]; .op == "DELETE" and .actor.type? == "user" and .actor.id? == "alice" and .actor_source == "comment")
    ' <<<"$history_json" >/dev/null \
    || fail "${label} history --format json assertions failed: ${history_json}"
  assert_not_contains "$history_json" "password_hash" "${label} history json"
  assert_not_contains "$history_json" "secret-" "${label} history json"

  export_jsonl="$(run_cli "$app_dir" "$admin_url" export --format jsonl --quiet)"
  [[ -n "$export_jsonl" ]] || fail "${label} auditstream export produced empty output"
  jq -se \
    --argjson inv_id "$invoice_id" \
    --arg agent "$expected_agent" \
    --arg upd_src "$expected_update_source" \
    --arg req_id "$expected_req_id" \
    '
      any(.[]; .source == "db" and .table_name == "invoice" and .op == "INSERT" and .record_id.id? == $inv_id and .actor.id? == "alice" and .actor_source == "comment" and .context.requestId? == $req_id) and
      any(.[]; .source == "db" and .table_name == "invoice" and .op == "DELETE" and .record_id.id? == $inv_id and .actor.id? == "alice" and .actor_source == "comment") and
      any(.[]; .source == "app" and .op == "invoice.exported" and .record_id.id? == $inv_id and .actor.id? == "alice") and
      any(.[]; .record_id.id? == $inv_id and .actor.id? == $agent and .actor.onBehalfOf.id? == "alice" and .actor.tenant? == "acme" and .actor_source == $upd_src)
    ' <<<"$export_jsonl" >/dev/null \
    || fail "${label} auditstream export assertions failed: ${export_jsonl}"
  assert_not_contains "$export_jsonl" "password_hash" "${label} export jsonl"
  assert_not_contains "$export_jsonl" "secret-" "${label} export jsonl"

  if [[ "$has_diff" -eq 1 ]]; then
    echo "  - ${label}: CLI status, verify, history --diff + --format json, and export jsonl verified"
  else
    echo "  - ${label}: CLI status, verify, history (table + --format json), and export jsonl verified"
  fi
}

echo "==> Starting hono-drizzle (:${HONO_PORT}) and prisma-api (:${PRISMA_PORT}) via PgBouncer (:${PGBOUNCER_PORT})..."
# Launch Node directly so SIGTERM triggers registerGracefulShutdown and wait reaps Node cleanly.
(
  cd "${RUN_ROOT}/hono-drizzle"
  DATABASE_URL="$APP_URL_DRIZZLE" PORT="$HONO_PORT" exec node dist/hono-drizzle/src/index.js
) >"$HONO_LOG" 2>&1 &
HONO_PID=$!

(
  cd "${RUN_ROOT}/prisma-api"
  DATABASE_URL="$APP_URL_PRISMA" PORT="$PRISMA_PORT" exec node dist/prisma-api/src/index.js
) >"$PRISMA_LOG" 2>&1 &
PRISMA_PID=$!

HONO_BASE="http://127.0.0.1:${HONO_PORT}"
PRISMA_BASE="http://127.0.0.1:${PRISMA_PORT}"

wait_for_http "hono-drizzle" "${HONO_BASE}/health" "$HONO_PID"
wait_for_http "prisma-api" "${PRISMA_BASE}/health" "$PRISMA_PID"

echo "==> Exercising hono-drizzle interactive flows..."
assert_http_error_contracts "hono-drizzle" "$HONO_BASE"

http_json POST "${HONO_BASE}/invoices" 201 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -H "x-request-id: req-hono-1" \
  -d '{"status":"draft","total":"50.00","passwordHash":"secret-hono-initial"}'
jq -e '.total == "50.00" and .status == "draft"' <<<"$HTTP_BODY" >/dev/null \
  || fail "hono-drizzle unexpected POST /invoices response: ${HTTP_BODY}"
hono_inv_id="$(jq -r '.id' <<<"$HTTP_BODY")"
[[ "$hono_inv_id" =~ ^[0-9]+$ ]] || fail "hono-drizzle invalid invoice id: ${HTTP_BODY}"

# Excluded-only column updates (rotation and null-clear) must both be suppressed as no-ops.
http_json PATCH "${HONO_BASE}/invoices/${hono_inv_id}" 200 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"passwordHash":"secret-hono-rotated"}'
http_json PATCH "${HONO_BASE}/invoices/${hono_inv_id}" 200 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"passwordHash":null}'
hono_inv_count="$(psql -X "$ADMIN_URL_DRIZZLE" -Atc "SELECT count(*) FROM auditstream.changes WHERE table_name = 'invoice' AND record_id = jsonb_build_object('id', ${hono_inv_id})")"
assert_eq "$hono_inv_count" "1" "hono-drizzle excluded-only update no-op suppression"

# Delegated AI agent + committed nested SAVEPOINT + rolled-back SAVEPOINT.
http_json POST "${HONO_BASE}/invoices/${hono_inv_id}/finalize" 200 \
  -H "content-type: application/json" \
  -H "x-demo-agent: bot_billing" \
  -H "x-demo-on-behalf-of: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"amount":"125.50","description":"Q4 subscription","simulateSavepointRollback":true}'
jq -e '.rolledBackSavepoint == true and .invoice.status == "finalized" and .invoice.total == "125.50"' <<<"$HTTP_BODY" >/dev/null \
  || fail "hono-drizzle finalize unexpected body: ${HTTP_BODY}"

sp_committed="$(psql -X "$ADMIN_URL_DRIZZLE" -Atc "SELECT count(*) FROM auditstream.changes WHERE table_name = 'line_item' AND after->>'invoice_id' = '${hono_inv_id}' AND after->>'description' = 'Q4 subscription' AND actor->>'id' = 'bot_billing' AND actor->'onBehalfOf'->>'id' = 'alice' AND actor_source = 'comment'")"
assert_eq "$sp_committed" "1" "hono-drizzle committed nested savepoint actor attribution"

sp_leaked="$(psql -X "$ADMIN_URL_DRIZZLE" -Atc "SELECT count(*) FROM auditstream.changes WHERE table_name = 'line_item' AND after->>'invoice_id' = '${hono_inv_id}' AND after->>'description' = 'Rolled back savepoint adjustment'")"
assert_eq "$sp_leaked" "0" "hono-drizzle rolled-back savepoint audit rows"

# Full transaction rollback (must produce 409 and zero audit rows).
http_json POST "${HONO_BASE}/invoices/${hono_inv_id}/finalize" 409 \
  -H "content-type: application/json" \
  -H "x-demo-agent: bot_billing" \
  -H "x-demo-on-behalf-of: alice" \
  -d '{"amount":"999.99","description":"Should roll back","simulateTxRollback":true}'
tx_leaked="$(psql -X "$ADMIN_URL_DRIZZLE" -Atc "SELECT count(*) FROM auditstream.changes WHERE (record_id = jsonb_build_object('id', ${hono_inv_id}) AND after->>'total' = '999.99') OR (after->>'invoice_id' = '${hono_inv_id}' AND after->>'description' = 'Should roll back')")"
assert_eq "$tx_leaked" "0" "hono-drizzle full transaction rollback audit rows"

# Raw SQL direct pool query outside Drizzle query builder.
http_json POST "${HONO_BASE}/invoices/${hono_inv_id}/raw-note" 201 \
  -H "content-type: application/json" \
  -H "x-demo-user: bob" \
  -H "x-demo-tenant: acme" \
  -d '{"description":"Direct pool query","amount":"15.00"}'
raw_note_actor="$(psql -X "$ADMIN_URL_DRIZZLE" -Atc "SELECT actor->>'id' FROM auditstream.changes WHERE table_name = 'line_item' AND after->>'invoice_id' = '${hono_inv_id}' AND after->>'description' = 'Direct pool query' ORDER BY id DESC LIMIT 1")"
assert_eq "$raw_note_actor" "bob" "hono-drizzle raw SQL actor attribution"

# Application-level event via audit.log() + delete invoice + BFF activity feed.
http_json POST "${HONO_BASE}/invoices/${hono_inv_id}/events" 201 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"action":"invoice.exported","format":"pdf"}'

http_json DELETE "${HONO_BASE}/invoices/${hono_inv_id}" 200 \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme"

assert_activity_feed "hono-drizzle" "$HONO_BASE" "$hono_inv_id" "alice"
assert_no_secret_in_db "hono-drizzle" "$ADMIN_URL_DRIZZLE"
assert_tamper_denied "hono-drizzle" "$APP_URL_DRIZZLE"
assert_no_prepared_statement_leak "hono-drizzle" "$APP_URL_DRIZZLE"

echo "==> Exercising prisma-api interactive flows..."
assert_http_error_contracts "prisma-api" "$PRISMA_BASE"

http_json POST "${PRISMA_BASE}/invoices" 201 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -H "x-request-id: req-prisma-1" \
  -d '{"status":"draft","total":"80.00","passwordHash":"secret-prisma-initial"}'
jq -e '.total == "80.00" and .status == "draft"' <<<"$HTTP_BODY" >/dev/null \
  || fail "prisma-api unexpected POST /invoices response (expected 2-decimal total): ${HTTP_BODY}"
prisma_inv_id="$(jq -r '.id' <<<"$HTTP_BODY")"
[[ "$prisma_inv_id" =~ ^[0-9]+$ ]] || fail "prisma-api invalid invoice id: ${HTTP_BODY}"

http_json PATCH "${PRISMA_BASE}/invoices/${prisma_inv_id}" 200 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"passwordHash":"secret-prisma-rotated"}'
http_json PATCH "${PRISMA_BASE}/invoices/${prisma_inv_id}" 200 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"passwordHash":null}'
prisma_inv_count="$(psql -X "$ADMIN_URL_PRISMA" -Atc "SELECT count(*) FROM auditstream.changes WHERE table_name = 'invoice' AND record_id = jsonb_build_object('id', ${prisma_inv_id})")"
assert_eq "$prisma_inv_count" "1" "prisma-api excluded-only update no-op suppression"

# Delegated AI agent via auditTransaction() (set_config fallback).
http_json POST "${PRISMA_BASE}/invoices/${prisma_inv_id}/approve" 200 \
  -H "content-type: application/json" \
  -H "x-demo-agent: bot_approver" \
  -H "x-demo-on-behalf-of: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"status":"approved"}'
jq -e '.total == "80.00" and .status == "approved"' <<<"$HTTP_BODY" >/dev/null \
  || fail "prisma-api unexpected POST /approve response: ${HTTP_BODY}"

prisma_approve_src="$(psql -X "$ADMIN_URL_PRISMA" -Atc "SELECT actor_source FROM auditstream.changes WHERE table_name = 'invoice' AND record_id = jsonb_build_object('id', ${prisma_inv_id}) AND op = 'UPDATE' AND after->>'status' = 'approved' ORDER BY id DESC LIMIT 1")"
assert_eq "$prisma_approve_src" "set_config" "prisma-api auditTransaction actor_source"

http_json POST "${PRISMA_BASE}/invoices/${prisma_inv_id}/events" 201 \
  -H "content-type: application/json" \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme" \
  -d '{"action":"invoice.exported","format":"csv"}'

http_json DELETE "${PRISMA_BASE}/invoices/${prisma_inv_id}" 200 \
  -H "x-demo-user: alice" \
  -H "x-demo-tenant: acme"

assert_activity_feed "prisma-api" "$PRISMA_BASE" "$prisma_inv_id" "alice"
assert_no_secret_in_db "prisma-api" "$ADMIN_URL_PRISMA"
assert_tamper_denied "prisma-api" "$APP_URL_PRISMA"
assert_no_prepared_statement_leak "prisma-api" "$APP_URL_PRISMA"

# Stop HTTP apps cleanly before CLI export so no open pooled transactions can hold back xmin.
stop_pid "$HONO_PID"
stop_pid "$PRISMA_PID"
HONO_PID=""
PRISMA_PID=""

echo "==> Verifying live auditstream CLI on both databases..."
verify_cli_outputs \
  "hono-drizzle" \
  "${RUN_ROOT}/hono-drizzle" \
  "$ADMIN_URL_DRIZZLE" \
  "$hono_inv_id" \
  "bot_billing" \
  "finalized" \
  "comment" \
  "req-hono-1"

verify_cli_outputs \
  "prisma-api" \
  "${RUN_ROOT}/prisma-api" \
  "$ADMIN_URL_PRISMA" \
  "$prisma_inv_id" \
  "bot_approver" \
  "approved" \
  "set_config" \
  "req-prisma-1"

echo ""
echo "PASS: all interactive HTTP, PgBouncer, tamper-resistance, and auditstream CLI checks succeeded!"
