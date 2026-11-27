#!/usr/bin/env bash
# Bootstraps isolated consumer copies of hono-drizzle and prisma-api in .tmp/run/,
# installs real npm or local .tgz artifacts, runs live `auditstream init` against
# PostgreSQL, applies migrations, grants least-privilege app_user access, and runs
# `auditstream verify` on both databases.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

require_cmd node
require_cmd pnpm
require_cmd psql
require_cmd realpath

find_single_tgz() {
  local dir="$1"
  local pattern="$2"
  if [[ ! -d "$dir" ]]; then
    echo "ERROR: AUDITSTREAM_JS_TGZ_DIR is not an existing directory: ${dir}" >&2
    exit 1
  fi
  local count=0 first_match="" file
  # Trailing slash ensures POSIX/GNU/BSD find traverses symlinked directories (e.g., /tmp on macOS).
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    count=$((count + 1))
    if [[ "$count" -eq 1 ]]; then
      first_match="$file"
    fi
  done < <(find "${dir%/}/" -maxdepth 1 -type f -name "$pattern" | sort)

  if [[ "$count" -ne 1 ]]; then
    echo "ERROR: expected exactly 1 tarball matching '${pattern}' in ${dir}, found ${count}" >&2
    exit 1
  fi
  realpath "$first_match"
}

# Validate local tarball inputs before wiping databases or .tmp/run.
node_tgz=""
drizzle_tgz=""
prisma_tgz=""
if [[ -n "${AUDITSTREAM_JS_TGZ_DIR:-}" ]]; then
  tgz_dir_real="$(realpath "$AUDITSTREAM_JS_TGZ_DIR" 2>/dev/null || true)"
  if [[ -z "$tgz_dir_real" || ! -d "$tgz_dir_real" ]]; then
    echo "ERROR: AUDITSTREAM_JS_TGZ_DIR is not an existing directory: ${AUDITSTREAM_JS_TGZ_DIR}" >&2
    exit 1
  fi
  case "$tgz_dir_real" in
    "${RUN_ROOT}"|"${RUN_ROOT}"/*)
      echo "ERROR: AUDITSTREAM_JS_TGZ_DIR cannot reside inside ${RUN_ROOT} (which bootstrap recreates)" >&2
      exit 1
      ;;
  esac
  node_tgz="$(find_single_tgz "$tgz_dir_real" 'auditstream-node-*.tgz')"
  drizzle_tgz="$(find_single_tgz "$tgz_dir_real" 'auditstream-drizzle-*.tgz')"
  prisma_tgz="$(find_single_tgz "$tgz_dir_real" 'auditstream-prisma-*.tgz')"
fi

CLI_BIN="$(resolve_auditstream_bin)"
echo "==> Using auditstream CLI: ${CLI_BIN}"
"$CLI_BIN" --version

echo "==> Waiting for PostgreSQL (127.0.0.1:${PG_PORT}) and PgBouncer (127.0.0.1:${PGBOUNCER_PORT})..."
wait_for_sql "PostgreSQL (lab_drizzle)" "$ADMIN_URL_DRIZZLE"
wait_for_sql "PostgreSQL (lab_prisma)" "$ADMIN_URL_PRISMA"
wait_for_sql "PgBouncer (lab_drizzle)" "$APP_URL_DRIZZLE"
wait_for_sql "PgBouncer (lab_prisma)" "$APP_URL_PRISMA"

reset_database() {
  local db_url="$1"
  # Reuse roles (never drop auditstream_owner or app_user) so PgBouncer never holds stale role OIDs.
  psql -X "$db_url" -v ON_ERROR_STOP=1 -q <<'EOSQL'
DROP SCHEMA IF EXISTS auditstream CASCADE;
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP TABLE IF EXISTS public.line_item, public.invoice, public._prisma_migrations CASCADE;
GRANT USAGE ON SCHEMA public TO app_user;
EOSQL
}

grant_runtime_privileges() {
  local db_url="$1"
  # Least-privilege runtime role: SELECT-only on auditstream.changes + EXECUTE on log_event.
  psql -X "$db_url" -v ON_ERROR_STOP=1 -q <<'EOSQL'
GRANT USAGE ON SCHEMA auditstream TO app_user;
GRANT SELECT ON auditstream.changes TO app_user;
GRANT EXECUTE ON FUNCTION auditstream.log_event(text, jsonb, jsonb) TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.invoice, public.line_item TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
EOSQL
}

stage_clean_app() {
  local src_dir="$1"
  local dst_dir="$2"
  cp -R "$src_dir" "$dst_dir"
  # Strip any untracked local dev build/install artifacts if present in the source tree.
  rm -rf \
    "${dst_dir}/node_modules" \
    "${dst_dir}/dist" \
    "${dst_dir}/generated" \
    "${dst_dir}/pnpm-lock.yaml" \
    "${dst_dir}/auditstream.toml"
}

write_isolated_pnpm_config() {
  local app_dir="$1"
  printf 'registry=%s\n' "$NPM_REGISTRY" > "${app_dir}/.npmrc"
  cat > "${app_dir}/pnpm-workspace.yaml" <<'EOYAML'
packages:
  - "."
allowBuilds:
  "@prisma/engines": false
  "prisma": false
EOYAML
}

inject_local_tarballs() {
  local app_dir="$1"
  local tgz_node="$2"
  local tgz_adapter_pkg="$3"
  local tgz_adapter_file="$4"

  node - "$app_dir/package.json" "$app_dir/pnpm-workspace.yaml" "$tgz_node" "$tgz_adapter_pkg" "$tgz_adapter_file" <<'EOF'
const fs = require("node:fs");
const [pkgPath, wsPath, nodeTgz, adapterPkg, adapterTgz] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies["@auditstream/node"] = `file:${nodeTgz}`;
pkg.dependencies[adapterPkg] = `file:${adapterTgz}`;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const wsYaml = [
  "packages:",
  '  - "."',
  "allowBuilds:",
  '  "@prisma/engines": false',
  '  "prisma": false',
  "overrides:",
  `  "@auditstream/node": ${JSON.stringify(`file:${nodeTgz}`)}`,
  `  ${JSON.stringify(adapterPkg)}: ${JSON.stringify(`file:${adapterTgz}`)}`,
  "",
].join("\n");
fs.writeFileSync(wsPath, wsYaml);
EOF
}

assert_path_within_dir() {
  local target="$1"
  local app_real="$2"
  if [[ -L "$target" && ! -e "$target" ]]; then
    echo "ERROR: dangling symlink detected in isolated consumer dir: $target" >&2
    exit 1
  fi
  local resolved
  resolved="$(realpath "$target")"
  case "$resolved" in
    "${app_real}"/*) ;;
    *)
      echo "ERROR: path $target resolves outside isolated consumer dir ($resolved)" >&2
      exit 1
      ;;
  esac
}

verify_no_external_symlinks() {
  local app_dir="$1"
  local app_real pkg link resolved checked=0
  app_real="$(realpath "$app_dir")"

  shopt -s nullglob
  for pkg in "$app_dir"/node_modules/@auditstream/*; do
    assert_path_within_dir "$pkg" "$app_real"
    resolved="$(realpath "$pkg")"
    while IFS= read -r link; do
      [[ -n "$link" ]] || continue
      assert_path_within_dir "$link" "$app_real"
    done < <(find "$resolved" -type l)
    checked=$((checked + 1))
  done
  shopt -u nullglob

  if [[ "$checked" -lt 2 ]]; then
    echo "ERROR: expected at least 2 @auditstream/* packages in ${app_dir}/node_modules/@auditstream, found ${checked}" >&2
    exit 1
  fi

  # Also inspect all transitive @auditstream symlinks under pnpm's virtual store.
  if [[ -d "${app_dir}/node_modules/.pnpm" ]]; then
    while IFS= read -r link; do
      [[ -n "$link" ]] || continue
      assert_path_within_dir "$link" "$app_real"
    done < <(find "${app_dir}/node_modules/.pnpm" -path '*/node_modules/@auditstream/*' -type l)
  fi
}

bootstrap_app() {
  local app_name="$1"
  local migration_mode="$2"
  local migrate_script="$3"
  local admin_url="$4"
  local app_dir="${RUN_ROOT}/${app_name}"

  echo "==> Installing isolated dependencies for ${app_name}..."
  (
    cd "$app_dir"
    pnpm install --no-frozen-lockfile
    verify_no_external_symlinks "$app_dir"
    pnpm run build
    DATABASE_URL="$admin_url" pnpm run "$migrate_script"
  )

  echo "==> Running live 'auditstream init --migrations ${migration_mode}'..."
  (
    cd "$app_dir"
    "$CLI_BIN" --database-url "$admin_url" init \
      --migrations "$migration_mode" \
      --table public.invoice \
      --table public.line_item \
      --exclude public.invoice.password_hash
    DATABASE_URL="$admin_url" pnpm run "$migrate_script"
  )
  grant_runtime_privileges "$admin_url"

  echo "==> Verifying ${app_name} with live 'auditstream verify'..."
  (
    cd "$app_dir"
    "$CLI_BIN" --database-url "$admin_url" verify
  )
}

echo "==> Resetting lab_drizzle and lab_prisma..."
reset_database "$ADMIN_URL_DRIZZLE"
reset_database "$ADMIN_URL_PRISMA"

echo "==> Staging clean isolated consumer apps in ${RUN_ROOT}..."
rm -rf "$RUN_ROOT"
mkdir -p "$RUN_ROOT"
stage_clean_app "${LAB_ROOT}/apps/shared" "${RUN_ROOT}/shared"
stage_clean_app "${LAB_ROOT}/apps/hono-drizzle" "${RUN_ROOT}/hono-drizzle"
stage_clean_app "${LAB_ROOT}/apps/prisma-api" "${RUN_ROOT}/prisma-api"

write_isolated_pnpm_config "${RUN_ROOT}/hono-drizzle"
write_isolated_pnpm_config "${RUN_ROOT}/prisma-api"

if [[ -n "$node_tgz" ]]; then
  echo "==> Using local release-candidate tarballs from ${AUDITSTREAM_JS_TGZ_DIR}..."
  mkdir -p "${RUN_ROOT}/tarballs"
  cp "$node_tgz" "${RUN_ROOT}/tarballs/"
  cp "$drizzle_tgz" "${RUN_ROOT}/tarballs/"
  cp "$prisma_tgz" "${RUN_ROOT}/tarballs/"

  inject_local_tarballs \
    "${RUN_ROOT}/hono-drizzle" \
    "../tarballs/$(basename "$node_tgz")" \
    "@auditstream/drizzle" \
    "../tarballs/$(basename "$drizzle_tgz")"

  inject_local_tarballs \
    "${RUN_ROOT}/prisma-api" \
    "../tarballs/$(basename "$node_tgz")" \
    "@auditstream/prisma" \
    "../tarballs/$(basename "$prisma_tgz")"
else
  echo "==> Installing published @auditstream/* packages from npm..."
fi

bootstrap_app "hono-drizzle" "drizzle" "migrate" "$ADMIN_URL_DRIZZLE"
bootstrap_app "prisma-api" "prisma" "prisma:migrate" "$ADMIN_URL_PRISMA"

# Record resolved CLI path as final completion marker for smoke-interactive.sh, start-apps.sh,
# and README CLI examples (written only after both apps pass auditstream verify).
printf '%s\n' "$CLI_BIN" > "${RUN_ROOT}/cli-bin.path"

echo ""
echo "Bootstrap complete!"
echo "  - CLI binary:   ${CLI_BIN}"
echo "  - hono-drizzle: ${RUN_ROOT}/hono-drizzle (DB: lab_drizzle)"
echo "  - prisma-api:   ${RUN_ROOT}/prisma-api   (DB: lab_prisma)"
echo "Next:"
echo "  ./scripts/smoke-interactive.sh   # automated end-to-end interactive verification"
echo "  ./scripts/start-apps.sh          # run both HTTP servers interactively"
