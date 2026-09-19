# CLAUDE.md

Project-local instructions for Claude Code sessions working *on* this repo
(`open-brain-lmstudio` itself — setup, development, deployment). For
guidance on how an agent should *use* the deployed MCP server's tools well
(search before investigating, capture self-contained thoughts, etc.), see
[`docs/claude-md-snippet.md`](docs/claude-md-snippet.md) — that's scoped
to the operator, not this repo, meant to be copied into their own
CLAUDE.md wherever they keep it (top-level/global suggested), not read as
instructions for this repo itself.

## What this is

A standalone Docker Compose deployment: `db` (Postgres 18 + pgvector,
Alpine, custom-built) + `mcp-server` (Deno/Hono MCP server, 6 tools) for a
self-hosted personal knowledge-capture tool, using a local LM Studio
instance for embeddings and chat instead of any cloud API. Forked/trimmed
from NateBJones-Projects/OB1's `integrations/kubernetes-deployment` — see
`NOTICE` for attribution and license scope before making large structural
changes to `mcp-server/index.ts`.

Standalone on purpose: not wired into any other infrastructure/automation,
no ingestion/scraping jobs, LAN-only.

## Setup for local development/testing

1. Docker with Compose v2.
2. LM Studio (https://lmstudio.ai) running locally: Developer tab -> Start
   server, with an embedding model and a chat model loaded. See the
   README's "First time using LM Studio? Quick setup" for full detail,
   including the `/api/v0/models` readiness-check gotcha (`/v1/models`
   alone is not a readiness check — see below).
3. `./setup.sh` generates `.env` from `.env.example` and fills in secrets.
4. Edit `.env`: `EMBEDDING_MODEL`/`CHAT_MODEL` need the exact LM Studio
   identifier strings — no defaults, the server refuses to start without
   them.
5. `docker compose up -d --build`

## Verifying a change

Every change to this repo should be checked this way before opening a PR —
a clean `deno check` or a successful `docker build` alone is not enough,
both can pass while the actual feature is broken.

1. `docker build -t <name> ./mcp-server` (or `./db`) — catches
   syntax/Dockerfile errors.
2. `docker run --rm <image> deno check index.ts` — expect exactly 9
   pre-existing `implicitAny` warnings, all on the zod-inferred
   destructured params of `registerTool` callbacks (a `deno check`
   quirk without the project's own type inference context, not a real
   bug — every tool handler has one). More than 9 means your change
   introduced a real type issue; a different count or new error codes
   means something regressed.
3. For anything touching `mcp-server/index.ts`'s MCP tool logic (not just
   docs), bring up the real stack and hit it with actual `tools/call`
   requests. `capture_thought` and `search_thoughts` need a live LM
   Studio to test end-to-end, but `list_thoughts`, `update_thought`,
   `delete_thought`, and `thought_stats` can be fully verified without one
   — seed a row directly in Postgres and round-trip real MCP JSON-RPC
   calls over curl:
   ```bash
   cp .env.example .env
   # fill in POSTGRES_PASSWORD/MCP_ACCESS_KEY (or run ./setup.sh) and set
   # EMBEDDING_MODEL/CHAT_MODEL to any placeholder string — they're only
   # required to be non-empty for the server to start, not to be real
   # unless you're testing capture/search themselves
   docker compose up -d --build
   docker compose exec -T db psql -U postgres -d openbrain -c \
     "INSERT INTO thoughts (content, embedding, metadata) VALUES ('test', array_fill(0.1, ARRAY[768])::vector, '{}'::jsonb) RETURNING id;"
   MCP_KEY="$(grep -E '^MCP_ACCESS_KEY=' .env | cut -d= -f2-)"
   curl -s -X POST http://localhost:8000 \
     -H "x-brain-key: $MCP_KEY" -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_thoughts","arguments":{}}}'
   docker compose down -v
   ```
   The `array_fill(0.1, ARRAY[768])` matches this repo's current
   `EMBED_DIM` default (768) — adjust if that default has changed since.
4. `docker compose down -v` to tear down and remove the test volume when
   done — don't leave test data or containers behind.
5. `.github/workflows/trivy.yml` gates CRITICAL/HIGH findings on every PR
   automatically. If you touch either Dockerfile, run the same scan
   locally first (see the README's "Security scanning" section) — a CI
   round-trip is slower to iterate against than a local one.

## Known gotchas (don't re-discover these)

- **PG18's volume layout changed**: the official `postgres:18-alpine`
  image expects a single mount at `/var/lib/postgresql`, not the old
  PG<=17 direct mount at `/var/lib/postgresql/data`
  (docker-library/postgres#1259). Already handled in
  `docker-compose.yml` — don't revert it back to the old mount path.
- **Alpine's `postgresql-pgvector` apk package** installs extension files
  into Alpine's own postgresql tree (`/usr/share/postgresqlNN/`), which
  the official image's independently-built Postgres binary never reads
  from. `db/Dockerfile` bridges this with explicit `cp` commands into
  `/usr/local/share/postgresql/extension/` and
  `/usr/local/lib/postgresql/`. If you bump the Postgres major version,
  re-verify these paths — the `NN` segment is version-specific.
- **`deno-postgres` (pinned `v0.19.3`) returns `bigint`/`int8` columns as
  strings**, not JS numbers or native `bigint` (avoids precision loss past
  `2^53`) — matches `ThoughtMatch.id: string` already in `index.ts`. Any
  new query touching `thoughts.id` should follow the same pattern: accept
  the id as a string, bind it with an explicit `::bigint` cast in SQL.
- **LM Studio's OpenAI-compatible server rejects `response_format: {
  type: "json_object" }`** outright with a 400 — it only implements
  `json_schema` and `text`. `extractMetadata` in `index.ts` uses
  `json_schema`; don't revert to `json_object`, it will silently break
  every `capture_thought` call's metadata extraction (this exact
  regression already happened once — see git log around 2026-09-18 for
  the full incident and fix).
- **`EMBED_DIM` is a one-way door** once the `db` volume has data —
  changing its default in `docker-compose.yml` / `.env.example` /
  `mcp-server/index.ts` only affects fresh clones. It never retroactively
  fixes an already-initialized deployment; that needs the volume-reset
  procedure in the README's "Embedding dimension is a one-way door"
  section.
- **No `curl`/`jq`/`apt-get` inside the `mcp-server` container** — it runs
  as non-root `USER deno`, so package installs fail with a permission
  error. Use `deno eval` with its built-in `fetch` for any in-container
  connectivity check (see the README's Troubleshooting section for the
  exact one-liner).
- **`thought_connections.source_thought_id` is always the newer
  thought.** Every row is created during a `capture_thought` call,
  searching among strictly older existing thoughts — `source` is always
  the thought being captured, `target` is always the pre-existing one.
  `serendipity_digest`'s recent-echo slot and any future
  connection-direction logic depends on this holding. Don't create a
  `thought_connections` row from anywhere else without preserving it.
- **Entity name matching is case-insensitive at lookup time only**
  (`WHERE lower(name) = lower($1)` in `resolveEntities`), not enforced
  by a DB constraint — `entities.name`'s `UNIQUE` constraint is
  case-sensitive. First-seen casing wins for display. A citext extension
  would enforce this at the DB level but isn't used here to avoid an
  extra extension dependency for a single-user-scale edge case.

## Conventions

- Every change lands via a worktree branch + PR against `main`, never a
  direct commit to `main`. Merge with `--delete-branch`, then sync local
  `main` and remove the worktree.
- Trivy CI must pass (0 CRITICAL/HIGH findings with a known fix) before
  merging — `ignore-unfixed: true` is set deliberately, so a finding with
  no available fix yet is expected noise on this gate, not a blocker.
- This repo's own glue code (compose file, shell scripts, README, this
  file) is MIT-licensed. `mcp-server/index.ts` is forked from
  NateBJones-Projects/OB1 (FSL-1.1-MIT) — see `NOTICE` before making
  structural changes to it.
