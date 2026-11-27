# auditstream-lab

Live sandbox and consumer verification lab for [Auditstream](https://auditstream.dev) against real PostgreSQL, PgBouncer (`transaction` mode), the compiled `auditstream` CLI binary, and real npm / packed `.tgz` installs of `@auditstream/*` with **zero workspace symlinks**.

## What is inside

- **Infrastructure (`docker-compose.yml` + `docker/init/`)**:
  - PostgreSQL (`PG_VERSION=19` by default; compatible with `15` through `19`, with version-scoped `PGDATA=/var/lib/postgresql/pg${PG_VERSION}` inside `pg_data`).
  - PgBouncer `1.26` (`POOL_MODE=transaction`, `DEFAULT_POOL_SIZE=6`, `MAX_PREPARED_STATEMENTS=200`, `AUTH_TYPE=scram-sha-256`).
  - Least-privilege roles provisioned on boot: `auditstream_owner` (`NOLOGIN`, owns the `auditstream` schema) and `app_user` (`LOGIN`, runtime application role with `SELECT`-only on `auditstream.changes` and `EXECUTE` on `auditstream.log_event`).
  - Two isolated databases: `lab_drizzle` and `lab_prisma`.
- **Two live HTTP consumer apps (`apps/`)**:
  - `apps/hono-drizzle`: Hono + Drizzle ORM + `@auditstream/node/hono` + `@auditstream/drizzle/pg` (`wrapPgPool`), covering CRUD, excluded-column no-op updates (`password_hash`), delegated `ai_agent` + `onBehalfOf`, nested `SAVEPOINT` + rollback + full transaction rollback, direct raw `pool.query`, `audit.log()`, and an allowlisted `GET /activity` BFF feed.
  - `apps/prisma-api`: Hono + Prisma 7 (`@prisma/adapter-pg`) + `@auditstream/node/hono` + `@auditstream/prisma` SQL comments plugin + `auditTransaction()` (`set_config` fallback), `audit.log()`, and `GET /activity`.
- **Isolated staging (`scripts/bootstrap.sh`)**:
  - Stages clean consumer copies into `.tmp/run/` so tracked files in `apps/` stay clean and `node_modules/@auditstream/*` never links to sibling monorepo directories.
  - Writes a per-app `pnpm-workspace.yaml` (`packages: ["."]`) and `.npmrc` (`registry=${NPM_REGISTRY}`) before running `pnpm install --no-frozen-lockfile`.
  - Runs real `auditstream init` (`--migrations drizzle` and `--migrations prisma`), applies the generated migrations, grants least-privilege runtime permissions to `app_user`, and verifies both databases with `auditstream verify`.

## Prerequisites

- Docker & Docker Compose v2
- Bash (`3.2+` including stock macOS `/bin/bash`)
- Node.js `22.12+` and `pnpm 10.26+`
- `psql`, `curl`, `jq`, `tar`, `xz`, `realpath`, and `sha256sum` (or `shasum`)

## Quickstart (published artifacts)

1. Start PostgreSQL and PgBouncer:

   ```sh
   docker compose up -d
   ```

2. Bootstrap both apps using the latest published GitHub Release binary (SHA-256 verified) and published npm `@auditstream/*` packages:

   ```sh
   ./scripts/bootstrap.sh
   ```

3. Run the automated end-to-end smoke suite (starts both HTTP servers via PgBouncer as `app_user`, exercises all flows, checks tamper resistance and pooled PgBouncer `pg_prepared_statements`, and verifies `auditstream status`, `verify`, `history` including `--diff` when supported by the CLI binary plus `--format json`, and `export`):

   ```sh
   ./scripts/smoke-interactive.sh
   ```

4. Run the shared helper unit tests (Node built-in test runner, zero extra dependencies; on Node `22.12–22.17`, pass `--experimental-strip-types`):

   ```sh
   node --test tests/shared.test.ts
   ```

## Testing local release candidates

Point `bootstrap.sh` at a locally built `auditstream` binary and a directory containing packed `.tgz` tarballs (`auditstream-node-*.tgz`, `auditstream-drizzle-*.tgz`, `auditstream-prisma-*.tgz`):

```sh
AUDITSTREAM_BIN=/path/to/auditstream/target/release/auditstream \
AUDITSTREAM_JS_TGZ_DIR=/path/to/packed-tarballs \
./scripts/bootstrap.sh

AUDITSTREAM_BIN=/path/to/auditstream/target/release/auditstream \
./scripts/smoke-interactive.sh
```

`bootstrap.sh` copies the tarballs into `.tmp/run/tarballs`, writes a per-app `pnpm-workspace.yaml` with `overrides` pointing to those tarballs, installs with `pnpm install --no-frozen-lockfile`, and fails immediately if any `node_modules/@auditstream/*` package is missing, dangling, or resolves outside its isolated app directory.

### Optional environment variables

Override defaults via the shell or a local `.env` file (see [`.env.example`](.env.example); `.env` is gitignored):

- `PG_VERSION`, `PG_PORT`, `PGBOUNCER_PORT`, `PG_ADMIN_PASSWORD`, `APP_USER_PASSWORD`, `HONO_PORT`, `PRISMA_PORT`
- `AUDITSTREAM_BIN`: path to a local executable `auditstream` binary (honored by `bootstrap.sh` and `smoke-interactive.sh`).
- `AUDITSTREAM_JS_TGZ_DIR`: directory containing packed `@auditstream/{node,drizzle,prisma}` `.tgz` tarballs (honored by `bootstrap.sh`).
- `AUDITSTREAM_VERSION`: pin a specific GitHub Release version such as `0.1.0` instead of `latest` (cached separately per version under `.tmp/bin/`; honored by `bootstrap.sh` and `smoke-interactive.sh`).
- `AUDITSTREAM_FORCE_DOWNLOAD=1`: re-download the GitHub Release binary even if already cached (honored by `bootstrap.sh` and `smoke-interactive.sh`).
- `NPM_REGISTRY`: override the npm registry URL written into staged `.npmrc` files (default `https://registry.npmjs.org/`).

## Switching PostgreSQL versions

Override `PG_VERSION` (for example `15`, `17`, or `19`). Always tear down the stack when switching versions cleanly:

```sh
docker compose down -v
PG_VERSION=15 docker compose up -d
./scripts/bootstrap.sh
./scripts/smoke-interactive.sh
```

## Interactive exploration

Start both HTTP servers (connected to PgBouncer on `127.0.0.1:6432` as `app_user`):

```sh
./scripts/start-apps.sh
```

In a second terminal, send sample requests to `hono-drizzle` (`:3101`) and `prisma-api` (`:3102`):

```sh
# 1. Create an invoice as human user alice (passwordHash is excluded from auditstream.changes)
HONO_INV_ID="$(curl -sS -X POST http://127.0.0.1:3101/invoices \
  -H 'content-type: application/json' \
  -H 'x-demo-user: alice' \
  -H 'x-demo-tenant: acme' \
  -d '{"status":"draft","total":"50.00","passwordHash":"secret-1"}' | jq -r '.id')"

# 2. Finalize as a delegated AI agent acting on behalf of alice (with a rolled-back savepoint)
curl -sS -X POST "http://127.0.0.1:3101/invoices/${HONO_INV_ID}/finalize" \
  -H 'content-type: application/json' \
  -H 'x-demo-agent: bot_billing' \
  -H 'x-demo-on-behalf-of: alice' \
  -H 'x-demo-tenant: acme' \
  -d '{"amount":"125.50","description":"Q4 subscription","simulateSavepointRollback":true}'

# 3. Record an application event via audit.log() and inspect the allowlisted BFF activity feed
curl -sS -X POST "http://127.0.0.1:3101/invoices/${HONO_INV_ID}/events" \
  -H 'content-type: application/json' \
  -H 'x-demo-user: alice' \
  -H 'x-demo-tenant: acme' \
  -d '{"action":"invoice.exported","format":"pdf"}'

curl -sS 'http://127.0.0.1:3101/activity?limit=10' | jq

# 4. Exercise Prisma 7 + auditTransaction() (actor_source = set_config) on :3102
PRISMA_INV_ID="$(curl -sS -X POST http://127.0.0.1:3102/invoices \
  -H 'content-type: application/json' \
  -H 'x-demo-user: alice' \
  -H 'x-demo-tenant: acme' \
  -d '{"status":"draft","total":"80.00","passwordHash":"secret-2"}' | jq -r '.id')"

curl -sS -X POST "http://127.0.0.1:3102/invoices/${PRISMA_INV_ID}/approve" \
  -H 'content-type: application/json' \
  -H 'x-demo-agent: bot_approver' \
  -H 'x-demo-on-behalf-of: alice' \
  -H 'x-demo-tenant: acme' \
  -d '{"status":"approved"}'
```

Inspect the recorded audit trail with the live `auditstream` CLI:

```sh
CLI="$(cat .tmp/run/cli-bin.path)"
DRIZZLE_URL="postgresql://postgres:postgres_dev_password@127.0.0.1:5432/lab_drizzle"
PRISMA_URL="postgresql://postgres:postgres_dev_password@127.0.0.1:5432/lab_prisma"

(cd .tmp/run/hono-drizzle && "$CLI" --database-url "$DRIZZLE_URL" status)
(cd .tmp/run/hono-drizzle && "$CLI" --database-url "$DRIZZLE_URL" verify)
# `--diff` requires auditstream CLI builds with diff output support (v0.2.0+ / main);
# on v0.1.0, use `--format json` to inspect full `before`/`after` row snapshots.
(cd .tmp/run/hono-drizzle && "$CLI" --database-url "$DRIZZLE_URL" history --table public.invoice --diff)
(cd .tmp/run/hono-drizzle && "$CLI" --database-url "$DRIZZLE_URL" history --table public.invoice --format json)
(cd .tmp/run/hono-drizzle && "$CLI" --database-url "$DRIZZLE_URL" export --format jsonl)

(cd .tmp/run/prisma-api && "$CLI" --database-url "$PRISMA_URL" history --table public.invoice --format json)
```

> **Note:** Demo HTTP headers (`x-demo-user`, `x-demo-agent`, `x-demo-on-behalf-of`, `x-demo-tenant`) exist solely for local sandbox exploration. Production applications must derive actors and tenants from a verified session or JWT and fail closed on unauthenticated requests.

## Clean teardown

Stop and remove all containers, networks, and volumes:

```sh
docker compose down -v
```

To also remove local staged installs and cached binaries:

```sh
rm -rf .tmp
```
