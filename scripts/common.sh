# shellcheck shell=bash
# Shared environment, URL, readiness, server-lifecycle, and binary-resolution helpers
# for auditstream-lab scripts. Intended to be sourced, not executed directly.

set -euo pipefail

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUN_ROOT="${LAB_ROOT}/.tmp/run"
BIN_CACHE_DIR="${LAB_ROOT}/.tmp/bin"
export LAB_ROOT RUN_ROOT

ALLOWLISTED_ENV_KEYS="PG_VERSION PG_PORT PGBOUNCER_PORT PG_ADMIN_PASSWORD APP_USER_PASSWORD HONO_PORT PRISMA_PORT AUDITSTREAM_BIN AUDITSTREAM_JS_TGZ_DIR AUDITSTREAM_VERSION AUDITSTREAM_FORCE_DOWNLOAD NPM_REGISTRY"

trim_leading_ws() {
  local val="$1"
  printf '%s' "${val#"${val%%[![:space:]]*}"}"
}

trim_trailing_ws() {
  local val="$1"
  printf '%s' "${val%"${val##*[![:space:]]}"}"
}

is_allowlisted_env_key() {
  case "$1" in
    PG_VERSION|PG_PORT|PGBOUNCER_PORT|PG_ADMIN_PASSWORD|APP_USER_PASSWORD|HONO_PORT|PRISMA_PORT|AUDITSTREAM_BIN|AUDITSTREAM_JS_TGZ_DIR|AUDITSTREAM_VERSION|AUDITSTREAM_FORCE_DOWNLOAD|NPM_REGISTRY)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Parses a double-quoted .env value honoring Docker Compose v2 escape sequences
# (\", \\, \n, \r, \t) and optional trailing whitespace / `# comment`.
parse_double_quoted_env_value() {
  local raw="$1"
  local len="${#raw}" i=1 out="" ch next after
  while [[ "$i" -lt "$len" ]]; do
    ch="${raw:$i:1}"
    if [[ "$ch" == "\\" && $((i + 1)) -lt "$len" ]]; then
      next="${raw:$((i + 1)):1}"
      case "$next" in
        '"'|\\) out+="$next" ;;
        n) out+=$'\n' ;;
        r) out+=$'\r' ;;
        t) out+=$'\t' ;;
        *) out+="\\${next}" ;;
      esac
      i=$((i + 2))
      continue
    fi
    if [[ "$ch" == '"' ]]; then
      after="$(trim_leading_ws "${raw:$((i + 1))}")"
      if [[ -z "$after" || "${after:0:1}" == "#" ]]; then
        printf '%s' "$out"
        return 0
      fi
      return 1
    fi
    out+="$ch"
    i=$((i + 1))
  done
  return 1
}

# Parses a .env value matching Docker Compose v2 rules (Bash 3.2+ compatible):
# - double-quoted values expand escapes and preserve internal # and spaces
# - single-quoted values are verbatim up to the closing quote
# - unquoted values strip leading/trailing whitespace and inline comments preceded by whitespace
parse_env_value() {
  local raw
  raw="$(trim_leading_ws "$1")"
  if [[ "$1" != "$raw" && "${raw:0:1}" == "#" ]]; then
    return 0
  fi
  local first="${raw:0:1}"

  if [[ "$first" == '"' ]]; then
    local parsed_dq
    if parsed_dq="$(parse_double_quoted_env_value "$raw")"; then
      printf '%s' "$parsed_dq"
      return 0
    fi
  elif [[ "$first" == "'" ]]; then
    local rest="${raw:1}"
    if [[ "$rest" == *"'"* ]]; then
      local quoted="${rest%%\'*}"
      local after
      after="$(trim_leading_ws "${rest#*\'}")"
      if [[ -z "$after" || "${after:0:1}" == "#" ]]; then
        printf '%s' "$quoted"
        return 0
      fi
    fi
  fi

  local without_comment="$raw"
  if [[ "$without_comment" == *" #"* ]]; then
    without_comment="${without_comment%% \#*}"
  fi
  if [[ "$without_comment" == *$'\t#'* ]]; then
    without_comment="${without_comment%%$'\t#'*}"
  fi
  trim_trailing_ws "$without_comment"
}

# Load allowlisted keys from optional .env without executing arbitrary shell code.
# Shell environment variables (including explicit empty overrides like VAR="") always win
# over .env; duplicate keys within .env use last-wins to match Docker Compose v2 semantics.
load_env_file() {
  local env_file="${LAB_ROOT}/.env"
  [[ -f "$env_file" ]] || return 0

  local preexisting=" " k
  for k in $ALLOWLISTED_ENV_KEYS; do
    if [[ "${!k+x}" == "x" ]]; then
      preexisting+="${k} "
    fi
  done

  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="$(trim_leading_ws "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    case "$line" in
      export[[:space:]]*)
        line="$(trim_leading_ws "${line#export}")"
        ;;
    esac
    [[ "$line" == *=* ]] || continue
    key="$(trim_trailing_ws "${line%%=*}")"
    is_allowlisted_env_key "$key" || continue
    [[ "$preexisting" == *" ${key} "* ]] && continue
    val="$(parse_env_value "${line#*=}")"
    export "$key=$val"
  done < "$env_file"
}

# RFC 3986 percent-encoding for URI userinfo components (passwords).
urlencode_uri_component() {
  local LC_ALL=C
  local raw="$1"
  local out="" i ch hex
  for ((i = 0; i < ${#raw}; i++)); do
    ch="${raw:i:1}"
    case "$ch" in
      [a-zA-Z0-9._~-]) out+="$ch" ;;
      *)
        printf -v hex '%%%02X' "'$ch"
        out+="$hex"
        ;;
    esac
  done
  printf '%s' "$out"
}

load_env_file

PG_VERSION="${PG_VERSION:-19}"
PG_PORT="${PG_PORT:-5432}"
PGBOUNCER_PORT="${PGBOUNCER_PORT:-6432}"
PG_ADMIN_PASSWORD="${PG_ADMIN_PASSWORD:-postgres_dev_password}"
APP_USER_PASSWORD="${APP_USER_PASSWORD:-app_dev_password}"
HONO_PORT="${HONO_PORT:-3101}"
PRISMA_PORT="${PRISMA_PORT:-3102}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"

case "$APP_USER_PASSWORD" in
  *\"*|*$'\n'*|*$'\r'*)
    echo "ERROR: APP_USER_PASSWORD must not contain double quotes or newlines (PgBouncer userlist.txt limitation)" >&2
    exit 1
    ;;
esac

export PG_VERSION PG_PORT PGBOUNCER_PORT PG_ADMIN_PASSWORD APP_USER_PASSWORD HONO_PORT PRISMA_PORT NPM_REGISTRY

PG_ADMIN_PW_ENC="$(urlencode_uri_component "$PG_ADMIN_PASSWORD")"
APP_USER_PW_ENC="$(urlencode_uri_component "$APP_USER_PASSWORD")"

ADMIN_URL_DRIZZLE="postgresql://postgres:${PG_ADMIN_PW_ENC}@127.0.0.1:${PG_PORT}/lab_drizzle"
ADMIN_URL_PRISMA="postgresql://postgres:${PG_ADMIN_PW_ENC}@127.0.0.1:${PG_PORT}/lab_prisma"
APP_URL_DRIZZLE="postgresql://app_user:${APP_USER_PW_ENC}@127.0.0.1:${PGBOUNCER_PORT}/lab_drizzle"
APP_URL_PRISMA="postgresql://app_user:${APP_USER_PW_ENC}@127.0.0.1:${PGBOUNCER_PORT}/lab_prisma"

export ADMIN_URL_DRIZZLE ADMIN_URL_PRISMA APP_URL_DRIZZLE APP_URL_PRISMA

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' is not installed or not on PATH" >&2
    exit 1
  fi
}

detect_release_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}:${arch}" in
    Linux:x86_64)  printf '%s' "x86_64-unknown-linux-gnu" ;;
    Linux:aarch64) printf '%s' "aarch64-unknown-linux-gnu" ;;
    Darwin:x86_64) printf '%s' "x86_64-apple-darwin" ;;
    Darwin:arm64)  printf '%s' "aarch64-apple-darwin" ;;
    *)
      echo "ERROR: unsupported platform ${os}/${arch}; provide AUDITSTREAM_BIN explicitly" >&2
      exit 1
      ;;
  esac
}

compute_sha256_hex() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print tolower($1)}'
  else
    echo "ERROR: neither sha256sum nor shasum is installed to verify release archive checksum" >&2
    exit 1
  fi
}

# Verifies that checksum_file records a 64-hex SHA-256 digest specifically for archive
# and that archive's computed SHA-256 digest matches exactly (prevents filename-redirect bypasses).
verify_archive_sha256() {
  local archive="$1"
  local checksum_file="$2"
  local expected="" actual="" line digest fname

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" ]] && continue
    digest="$(printf '%s\n' "$line" | awk '{print tolower($1)}')"
    fname="$(printf '%s\n' "$line" | sed -E 's/^[0-9A-Fa-f]{64}[[:space:]]+\*?//')"
    if [[ "$digest" =~ ^[0-9a-f]{64}$ && ( "$fname" == "$archive" || "$fname" == "./${archive}" ) ]]; then
      expected="$digest"
      break
    fi
  done < "$checksum_file"

  if [[ -z "$expected" ]]; then
    echo "ERROR: checksum file '${checksum_file}' did not contain a valid SHA-256 entry for '${archive}'" >&2
    exit 1
  fi

  actual="$(compute_sha256_hex "$archive")"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: SHA-256 mismatch for '${archive}' (expected ${expected}, got ${actual})" >&2
    exit 1
  fi
}

# Resolves the auditstream CLI binary from AUDITSTREAM_BIN or downloads a GitHub Release
# into a version-keyed cache with pinned SHA-256 verification and atomic installation.
resolve_auditstream_bin() {
  if [[ -n "${AUDITSTREAM_BIN:-}" ]]; then
    if [[ ! -f "$AUDITSTREAM_BIN" || ! -x "$AUDITSTREAM_BIN" ]]; then
      echo "ERROR: AUDITSTREAM_BIN is not an executable file: $AUDITSTREAM_BIN" >&2
      exit 1
    fi
    require_cmd realpath
    realpath "$AUDITSTREAM_BIN"
    return 0
  fi

  local cache_key base_url
  if [[ -n "${AUDITSTREAM_VERSION:-}" ]]; then
    if [[ ! "$AUDITSTREAM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
      echo "ERROR: invalid AUDITSTREAM_VERSION '${AUDITSTREAM_VERSION}'" >&2
      exit 1
    fi
    cache_key="auditstream-v${AUDITSTREAM_VERSION}"
    base_url="https://github.com/auditstream/auditstream/releases/download/auditstream-v${AUDITSTREAM_VERSION}"
  else
    cache_key="auditstream-latest"
    base_url="https://github.com/auditstream/auditstream/releases/latest/download"
  fi

  local cached="${BIN_CACHE_DIR}/${cache_key}"
  if [[ -f "$cached" && -x "$cached" && "${AUDITSTREAM_FORCE_DOWNLOAD:-0}" != "1" ]]; then
    printf '%s\n' "$cached"
    return 0
  fi

  require_cmd curl
  require_cmd tar

  local target archive
  target="$(detect_release_target)"
  archive="auditstream-${target}.tar.xz"

  # Run download, checksum verification, extraction, and atomic publish inside a subshell
  # whose signal/EXIT traps guarantee dl_dir and tmp_bin cleanup without swallowing signals.
  (
    dl_dir="$(mktemp -d)"
    tmp_bin=""
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'rm -rf "$dl_dir"; if [[ -n "$tmp_bin" ]]; then rm -f "$tmp_bin"; fi' EXIT

    echo "==> Downloading ${archive} from ${base_url}..." >&2
    curl -fsSL "${base_url}/${archive}" -o "${dl_dir}/${archive}"
    curl -fsSL "${base_url}/${archive}.sha256" -o "${dl_dir}/${archive}.sha256"

    (
      cd "$dl_dir"
      verify_archive_sha256 "$archive" "${archive}.sha256"
      tar -xJf "$archive"
    )

    extracted="$(find "$dl_dir" -type f -name "auditstream" -perm -100 | head -n 1)"
    if [[ -z "$extracted" ]]; then
      echo "ERROR: downloaded archive did not contain an executable 'auditstream' binary" >&2
      exit 1
    fi

    mkdir -p "$BIN_CACHE_DIR"
    tmp_bin="${cached}.tmp.$$"
    cp "$extracted" "$tmp_bin"
    chmod 0755 "$tmp_bin"
    mv -f "$tmp_bin" "$cached"
    tmp_bin=""
  )

  printf '%s\n' "$cached"
}

stop_pid() {
  local pid="${1:-}"
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

ensure_distinct_ports() {
  local first_port="$1"
  local second_port="$2"
  if [[ "$first_port" == "$second_port" ]]; then
    echo "ERROR: HONO_PORT and PRISMA_PORT must be distinct (both set to '${first_port}')" >&2
    exit 1
  fi
}

ensure_port_free() {
  local label="$1"
  local port="$2"
  if ! node - "$port" <<'EOF'
const net = require("node:net");
const raw = process.argv[2] ?? "";
if (!/^\d+$/.test(raw)) {
  process.exit(2);
}
const port = Number.parseInt(raw, 10);
if (port < 1 || port > 65535) {
  process.exit(2);
}
const server = net.createServer();
server.once("error", () => process.exit(1));
server.once("listening", () => server.close(() => process.exit(0)));
server.listen(port, "127.0.0.1");
EOF
  then
    echo "ERROR: port 127.0.0.1:${port} required for ${label} is already in use or invalid" >&2
    exit 1
  fi
}

wait_for_sql() {
  local label="$1"
  local url="$2"
  for _ in $(seq 1 30); do
    if psql -X "$url" -Atc "SELECT 1" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for ${label} after 30s" >&2
  exit 1
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local pid="${3:-}"
  local body=""
  for _ in $(seq 1 30); do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: ${label} process (PID ${pid}) exited before ${url} became ready" >&2
      exit 1
    fi
    if body="$(curl -fsS "$url" 2>/dev/null)" && [[ "$body" == *"\"app\":\"${label}\""* ]]; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for ${label} (${url}) after 30s" >&2
  exit 1
}
