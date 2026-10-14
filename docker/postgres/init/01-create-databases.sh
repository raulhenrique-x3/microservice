#!/bin/sh
# Creates one database per service (database-per-service ownership).
# Runs only on a fresh pgdata volume: `docker compose down -v` once if volumes exist.
set -e

create_db() {
  if psql -U "$POSTGRES_USER" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$1'" | grep -q 1; then
    echo "db $1 ok"
  else
    createdb -U "$POSTGRES_USER" "$1"
    echo "db $1 created"
  fi
}

create_db "${POSTGRES_DB_API:-converter_api}"
create_db "${POSTGRES_DB_WORKER:-converter_worker}"
create_db "${POSTGRES_DB_NOTIFIER:-converter_notifier}"
