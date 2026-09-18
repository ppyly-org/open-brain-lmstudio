#!/usr/bin/env bash
set -euo pipefail

# Plain sed substitution, not envsubst: envsubst replaces every $VARNAME it
# finds with the matching env var, empty string if unset, which would also
# mangle Postgres's $BODY$ dollar-quoting below unless given an explicit
# variable allowlist. sed is simpler and carries no such risk here.
[[ "${EMBED_DIM:-}" =~ ^[0-9]+$ ]] || {
  echo "EMBED_DIM must be a positive integer, got: ${EMBED_DIM:-<unset>}" >&2
  exit 1
}

sed "s/\${EMBED_DIM}/${EMBED_DIM}/g" \
  /docker-entrypoint-initdb.d/01-init.sql.template > /tmp/01-init.sql

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /tmp/01-init.sql
