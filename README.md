# open-brain-lmstudio

Self-hosted Open Brain MCP server — capture and semantically search personal
notes — backed by Docker Compose and a local [LM Studio](https://lmstudio.ai/)
instance for embeddings and metadata extraction. No cloud API keys. No
ingestion/scraping jobs. Two containers total: Postgres+pgvector, and the
MCP server.

Forked from [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1)'s
`integrations/kubernetes-deployment` (community contribution by
[@velo](https://github.com/velo)) — see `NOTICE` for full attribution and
license text (FSL-1.1-MIT). This repo's own glue code (compose file, shell
scripts, this README) is MIT-licensed — see `LICENSE`.

## What you get

- `db`: `pgvector/pgvector:pg16` with a `thoughts` table and a
  `match_thoughts()` SQL helper.
- `mcp-server`: a Deno/Hono MCP server exposing 4 tools over Streamable
  HTTP at `:8000`, authenticated via an `x-brain-key` header:
  - `capture_thought` — embed + extract metadata + store.
  - `search_thoughts` — semantic search by cosine similarity.
  - `list_thoughts` — filtered/paginated recent listing.
  - `thought_stats` — aggregate counts by type/topic/person.

## Prerequisites

- Docker with Compose v2.
- [LM Studio](https://lmstudio.ai/) running its local server (default port
  `1234`), with **one embedding model and one chat model loaded**. Any
  OpenAI-compatible embedding/chat model LM Studio can serve works — pick
  based on your hardware.
- `openssl` (used by `setup.sh` to generate secrets).

## Setup

1. Generate secrets:
   ```bash
   ./setup.sh
   ```
2. Edit `.env`:
   - `EMBEDDING_MODEL` / `CHAT_MODEL` — the exact model identifiers as
     LM Studio's "Local Server" tab shows them. Required; the server
     refuses to start without them.
   - `LM_STUDIO_URL` — only if LM Studio runs on a different machine than
     the one running `docker compose up` (default assumes the same
     machine, via `host.docker.internal`).
   - `EMBED_DIM` — only if your chosen embedding model's output dimension
     isn't 768. **This is a one-way door once `db`'s volume exists — see
     below.**
3. Bring up the stack:
   ```bash
   docker compose up -d
   docker compose ps
   ```

## Verifying your install

1. Both services healthy:
   ```bash
   docker compose ps
   ```
2. Schema present:
   ```bash
   docker compose exec db psql -U postgres -d openbrain -c "\d thoughts"
   ```
3. Tools list (4 tools, no more, no less):
   ```bash
   MCP_KEY="$(grep -E '^MCP_ACCESS_KEY=' .env | cut -d= -f2-)"
   curl -s -X POST http://localhost:8000 \
     -H "x-brain-key: $MCP_KEY" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```
4. Capture a thought (requires LM Studio reachable with both models loaded):
   ```bash
   curl -s -X POST http://localhost:8000 \
     -H "x-brain-key: $MCP_KEY" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capture_thought","arguments":{"content":"first thought from setup verification"}}}'
   ```
   Expected: a result confirming capture, and a new row in `thoughts`
   (verify with `docker compose exec db psql -U postgres -d openbrain -c "SELECT id, content FROM thoughts;"`).
5. Search for it:
   ```bash
   curl -s -X POST http://localhost:8000 \
     -H "x-brain-key: $MCP_KEY" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_thoughts","arguments":{"query":"setup verification"}}}'
   ```
   Expected: the thought from step 4 comes back above the default 0.5
   similarity threshold.
6. `list_thoughts` and `thought_stats` (same `tools/call` shape, no
   arguments needed beyond the tool name) return sane output against the
   now-populated `thoughts` table.
7. Restart just the server and confirm data survives:
   ```bash
   docker compose restart mcp-server
   ```
   then repeat step 5 — the earlier thought is still findable.
8. Deliberately misconfigure `EMBED_DIM` (edit `.env` to a different
   number, `docker compose up -d --force-recreate mcp-server`) without
   recreating the `db` volume, then repeat step 4 — expect a clear
   `embedding-dim mismatch` error, not silent corruption or a generic
   Postgres error.

## Connecting an MCP client

Point any Streamable-HTTP-capable MCP client at `http://<this-host>:8000`
with header `x-brain-key: <your MCP_ACCESS_KEY>`. Example (Claude
Desktop-style config):

```json
{
  "mcpServers": {
    "open-brain-lmstudio": {
      "url": "http://<this-host>:8000",
      "type": "http",
      "headers": {
        "x-brain-key": "<your MCP_ACCESS_KEY>"
      }
    }
  }
}
```

## Embedding dimension is a one-way door

`EMBED_DIM` is baked into the `thoughts.embedding` column when the `db`
volume is first initialized. pgvector enforces the dimension at insert
time. To change it on a volume that already has data:

```bash
docker compose down
docker volume rm open-brain-lmstudio_db_data
# edit .env: new EMBED_DIM, and point EMBEDDING_MODEL at a model that
# actually produces that dimension
docker compose up -d
# re-capture your thoughts — there is no automatic re-embedding
```

## Backup and restore

```bash
docker compose stop db
docker run --rm \
  -v open-brain-lmstudio_db_data:/from \
  -v "$(pwd)/backups:/to" \
  alpine tar czf "/to/db-$(date +%F).tar.gz" -C /from .
docker compose start db
```

Restore: `docker compose down`, `docker volume rm open-brain-lmstudio_db_data`,
recreate an empty volume (`docker compose up -d db` then `docker compose stop db`),
untar the backup into it, `docker compose up -d`.

## Troubleshooting

- **`mcp-server` exits immediately with `Missing required environment
  variable: ...`**: the name in the error is the container-internal
  variable, not always the `.env` key you need to edit — `docker-compose.yml`
  derives some of them:
  - `DB_PASSWORD` comes from `.env`'s `POSTGRES_PASSWORD`.
  - `EMBEDDING_API_BASE` (and `CHAT_API_BASE`, which defaults to it) come
    from `.env`'s `LM_STUDIO_URL`; this one has a compose-level default, so
    it's only reported missing if `.env` itself failed to load.
  - `EMBEDDING_MODEL`, `CHAT_MODEL`, `MCP_ACCESS_KEY` are literal `.env`
    keys — no translation needed.

  Check the relevant `.env` key is set, then
  `docker compose up -d --force-recreate mcp-server`.
- **`embedding-dim mismatch` on every capture/search**: your
  `EMBEDDING_MODEL` produces a different vector size than `EMBED_DIM`.
  Either pick a model matching the existing `EMBED_DIM`, or follow the
  one-way-door procedure above.
- **`Embedding API failed: ...` / connection refused**: LM Studio's local
  server isn't running, doesn't have a model loaded, or `LM_STUDIO_URL`
  doesn't reach it. The container runs as a non-root `deno` user, so
  `apt-get install curl` fails with a permission error — check
  connectivity with `deno eval` instead:
  ```bash
  docker compose exec mcp-server deno eval 'try { const r = await fetch(`${Deno.env.get("EMBEDDING_API_BASE")}/models`); console.log(r.status, await r.text()); } catch (e) { console.log("fetch failed:", e.message); }'
  ```
  A working LM Studio should print `200` and its model list; a connection
  failure prints the underlying error instead of a stack trace.
- **HTTP 401 from the MCP endpoint**: the `x-brain-key` header doesn't
  match `MCP_ACCESS_KEY` in `.env` — re-check what `setup.sh` printed, or
  re-read it with `grep MCP_ACCESS_KEY .env`.
