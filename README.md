# open-brain-lmstudio

Self-hosted Open Brain [MCP](https://modelcontextprotocol.io/) server —
capture and semantically search personal notes from any MCP-capable AI
client (Claude Code, Claude Desktop, etc.) — backed by Docker Compose and
a local [LM Studio](https://lmstudio.ai/) instance for embeddings and
metadata extraction. No cloud API keys. No ingestion/scraping jobs. Two
containers total: Postgres+pgvector, and the MCP server.

Forked from [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1)'s
`integrations/kubernetes-deployment` (community contribution by
[@velo](https://github.com/velo)) — see `NOTICE` for full attribution and
license text (FSL-1.1-MIT). This repo's own glue code (compose file, shell
scripts, this README) is MIT-licensed — see `LICENSE`.

## What you get

- `db`: Postgres 18 + pgvector on Alpine (`db/Dockerfile`, built from
  `postgres:18-alpine`) with a `thoughts` table and a `match_thoughts()`
  SQL helper. Built rather than pulled as `pgvector/pgvector:*` — that
  image has no Alpine variant, and its Debian-based tags carry a large
  HIGH/CRITICAL CVE count Alpine avoids.
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
  based on your hardware, or use the recommendation below.
- `openssl` (used by `setup.sh` to generate secrets).

### First time using LM Studio? Quick setup

1. Install LM Studio and, in its "Discover"/search tab, download an
   embedding model and a chat model (see "Recommended models" below for
   concrete picks).
2. Open the **Developer** tab in LM Studio's sidebar and load both
   models.
3. In the same tab, toggle **Start server** (default port `1234`).
4. Get the exact identifier string each model expects in API calls —
   don't guess it from the display name, confirm it:
   ```bash
   curl -s http://localhost:1234/v1/models
   ```
   Each entry's `"id"` field is what goes into this repo's
   `EMBEDDING_MODEL`/`CHAT_MODEL` in Setup step 2 below.
5. `/v1/models` above lists every downloaded model regardless of whether
   it's loaded or what kind it is — it is **not** a readiness check.
   Confirm your embedding model is both loaded and actually classified as
   an embedding model, via LM Studio's own native API:
   ```bash
   curl -s http://localhost:1234/api/v0/models
   ```
   Find your `EMBEDDING_MODEL`'s entry and confirm `"type": "embeddings"`
   and `"state": "loaded"`. If `"type"` comes back `"llm"` instead, LM
   Studio doesn't recognize that particular download as an embedding
   model and `/v1/embeddings` will never serve it, no matter how it's
   (re)loaded — pick a different embedding model or a different
   source/quant of the same one. See "Recommended models" below for a
   confirmed-working pick.

## Recommended models (Apple Silicon, 16-32GB unified memory)

Researched September 2026. If your hardware differs, any OpenAI-compatible
embedding/chat pair LM Studio can serve works — these are a concrete
starting point, not a hard requirement.

- **Embedding: [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF)**
  — dim **768**, ~280MB, smallest footprint of the models considered here,
  8k context. This repo's `EMBED_DIM` default (768) matches it. Confirmed
  in the field as reliably loadable and correctly classified as
  `"type": "embeddings"` by LM Studio (see step 5 above) — unlike some
  downloads of Qwen3-Embedding-0.6B, see "Alternatives" below.
- **Chat: [Gemma 4 E4B](https://lmstudio.ai/models/google/gemma-4-e4b)**
  (MLX build) — Google's edge release built for agentic workflows with
  native structured JSON output, which matches `capture_thought`'s
  metadata-extraction task (people/action_items/dates/topics/type as
  JSON) better than a general-purpose chat model. ~4.6GB at Q4/5bit.

Combined footprint is well under 6GB — both load simultaneously in LM
Studio with plenty of headroom even at 16GB. Prefer MLX builds over GGUF
on Apple Silicon for the chat model; they're faster and leaner on this
hardware.

**Alternatives**, if you want to trade quality/footprint differently:
- Embedding: **[Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)**
  (MLX build, native dim 1024, set `EMBED_DIM=1024` if you use it) —
  stronger multilingual quality and longer context (32k) than
  nomic-embed-text-v1.5. **Caveat, confirmed in the field:** some
  downloads/quants of this model register as LM Studio's generic `"llm"`
  type rather than `"embeddings"` — when that happens `/v1/embeddings`
  never serves it, regardless of how it's (re)loaded. Verify with step 5
  above before committing to it. Or `Qwen3-Embedding-4B` (2560-dim, ~4GB,
  better recall, needs 32GB+) once you've confirmed Qwen3 embeddings work
  on your setup.
- Chat: `Qwen3.5-4B` (~2.5GB, stays in the Qwen family) or `Phi-4-mini`
  (~2.5GB, smaller fallback) if Gemma 4 E4B's JSON-mode behavior doesn't
  suit your content.

Whatever you pick, set `EMBED_DIM` to match the embedding model's actual
output dimension **before your first `docker compose up`** — see
"Embedding dimension is a one-way door" below.

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
   - `EMBED_DIM` — defaults to 768, matching the recommended
     nomic-embed-text-v1.5 above. Only change it if your chosen embedding
     model's output dimension differs. **This is a one-way door once
     `db`'s volume exists — see below.**
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
   `mcp-server`'s healthcheck hits its own unauthenticated `/health`
   route, which pings the Postgres pool — so "healthy" here means the
   server is up *and* can reach the database, not just that the process
   is running.
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

Point any Streamable-HTTP-capable [MCP](https://modelcontextprotocol.io/)
client at `http://<this-host>:8000` with header
`x-brain-key: <your MCP_ACCESS_KEY>`. The exact config key for the
transport type differs by client (`"type": "http"` vs
`"type": "streamable-http"`) — use the one for your client below.

### Claude Code

Easiest: register it with the CLI (run this once, from anywhere):

```bash
claude mcp add --transport http open-brain-lmstudio http://<this-host>:8000 \
  --header "x-brain-key: <your MCP_ACCESS_KEY>"
```

`--scope user` registers it for every project instead of just the current
one: `claude mcp add --transport http --scope user open-brain-lmstudio ...`

Equivalent, if you'd rather edit the config file directly — project scope
goes in `.mcp.json` at your project root, user scope goes under
`mcpServers` in `~/.claude.json`:

```json
{
  "mcpServers": {
    "open-brain-lmstudio": {
      "type": "http",
      "url": "http://<this-host>:8000",
      "headers": {
        "x-brain-key": "<your MCP_ACCESS_KEY>"
      }
    }
  }
}
```

### Claude Desktop

Edit the config file directly (Claude Desktop has no CLI for this):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "open-brain-lmstudio": {
      "type": "streamable-http",
      "url": "http://<this-host>:8000",
      "headers": {
        "x-brain-key": "<your MCP_ACCESS_KEY>"
      }
    }
  }
}
```

Restart Claude Desktop after editing for the change to take effect.

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

## Security scanning

Both images are built from scratch (`db/Dockerfile`, `mcp-server/Dockerfile`)
on Alpine bases specifically because they carry far fewer OS-package CVEs
than the Debian-based defaults (`pgvector/pgvector:*` has no Alpine variant
at all, and Debian bookworm/trixie both run well over 90 HIGH/CRITICAL
findings; the official Deno image's Debian base carries dozens more).
`db/Dockerfile` also rebuilds the bundled `gosu` binary from source with a
current Go toolchain rather than using upstream's older prebuilt copy,
which otherwise carries ~20 Go-stdlib CVEs unrelated to what `gosu`
actually does at container startup.

[`.github/workflows/trivy.yml`](.github/workflows/trivy.yml) scans both
images on every PR and push to `main` with
[Trivy](https://github.com/aquasecurity/trivy-action), failing the check
on any CRITICAL/HIGH finding with a known fix (`ignore-unfixed: true` —
findings with no available fix would only ever be noise on a gate like
this). To run the same scan locally:

```bash
docker build -t open-brain-lmstudio-db:scan ./db
docker build -t open-brain-lmstudio-mcp-server:scan ./mcp-server
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image --severity CRITICAL,HIGH --ignore-unfixed \
  open-brain-lmstudio-db:scan
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image --severity CRITICAL,HIGH --ignore-unfixed \
  open-brain-lmstudio-mcp-server:scan
```

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
- **`capture_thought` fails with `Embedding API failed: ... No models
  loaded` even though `/v1/models` lists your embedding model**:
  `/v1/models` lists every downloaded model regardless of load state or
  type — it doesn't mean LM Studio considers it an embedding model. Check
  LM Studio's native API instead: `curl -s http://localhost:1234/api/v0/models`.
  If your model's entry shows `"type": "llm"` rather than
  `"type": "embeddings"`, LM Studio doesn't classify that particular
  download as embedding-capable and `/v1/embeddings` will never serve it.
  Switch to a different embedding model/source — see "Recommended models"
  above.
- **Every captured thought comes back `topics: ["uncategorized"]`**: this
  is `extractMetadata`'s fallback for when the chat model's response
  either fails outright or isn't valid JSON (including JSON wrapped in a
  ` ```json ` code fence, which some local models still emit even under
  `response_format: json_object`). Check `docker compose logs mcp-server`
  around the time of the capture — it now logs the actual HTTP status or
  raw model output that caused the fallback, rather than swallowing it
  silently. Common causes: `CHAT_MODEL` doesn't support `response_format:
  json_object`, or the loaded model just isn't reliable at the requested
  JSON shape — try a different chat model if the log points there.
