# Alpine-based Postgres + pgvector, built from the official images rather
# than pulled as pgvector/pgvector:*, which has no Alpine variant at all
# (checked: 0 of 183 published tags). Debian-based pgvector images carry a
# large HIGH/CRITICAL OS-package CVE count (96 on :pg16/bookworm, 126 on
# :pg18-trixie) that Alpine's much smaller package set avoids entirely.
#
# Alpine's own `postgresql-pgvector` apk package installs the extension
# into Alpine's own postgresql tree (/usr/share/postgresqlNN/), which the
# official postgres image's independently-built binary (/usr/local/...)
# never reads from -- so the extension files are copied across by hand.
#
# The official image's bundled `gosu` (used by docker-entrypoint.sh to
# drop from root to the postgres user at startup) is a prebuilt release
# binary built with an old Go toolchain, carrying ~22 HIGH/CRITICAL Go
# stdlib CVEs that have nothing to do with what gosu actually does at
# startup -- but Trivy still flags them, so gosu is rebuilt from source
# here with a current Go toolchain instead of relying on upstream's
# prebuilt binary.

FROM golang:1.27-alpine AS gosu-builder
RUN apk add --no-cache git
RUN CGO_ENABLED=0 go install github.com/tianon/gosu@latest

FROM postgres:18-alpine

RUN apk add --no-cache postgresql-pgvector && \
    cp /usr/share/postgresql18/extension/vector* /usr/local/share/postgresql/extension/ && \
    cp /usr/lib/postgresql18/vector.so /usr/local/lib/postgresql/

COPY --from=gosu-builder /go/bin/gosu /usr/local/bin/gosu
