#!/bin/sh
set -eu

# Provision least-privilege roles and isolated lab databases on initial Postgres boot.
# Local sandbox defaults only — never reuse these passwords outside disposable local Docker runs.
APP_PW="${APP_USER_PASSWORD:-app_dev_password}"

case "$APP_PW" in
  *\"*|*'
'*)
    echo "ERROR: APP_USER_PASSWORD must not contain double quotes or newlines (PgBouncer userlist.txt limitation)" >&2
    exit 1
    ;;
esac

psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_pw="$APP_PW" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'auditstream_owner') THEN
    EXECUTE 'CREATE ROLE auditstream_owner NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'CREATE ROLE app_user LOGIN';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'auditstream_owner', 'USAGE') THEN
    EXECUTE pg_catalog.format('GRANT auditstream_owner TO %I', current_user);
  END IF;
END
$$;

ALTER ROLE app_user LOGIN PASSWORD :'app_pw';

CREATE DATABASE lab_drizzle;
CREATE DATABASE lab_prisma;

GRANT CONNECT ON DATABASE lab_drizzle TO app_user;
GRANT CONNECT ON DATABASE lab_prisma TO app_user;
EOSQL

for db in lab_drizzle lab_prisma; do
  psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'EOSQL'
GRANT USAGE ON SCHEMA public TO app_user;
EOSQL
done
