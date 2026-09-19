/**
 * Open Brain MCP Server — LM Studio edition
 *
 * Forked from NateBJones-Projects/OB1's integrations/kubernetes-deployment
 * (see /NOTICE for attribution and license). Connects directly to
 * PostgreSQL + pgvector; calls an LM Studio instance's OpenAI-compatible
 * API for embeddings and chat. The search/fetch ChatGPT-connector
 * compatibility tools from upstream are intentionally not present here.
 *
 * Environment variables:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD - PostgreSQL connection
 *   EMBED_DIM - vector column dimension (must match the db schema)
 *   EMBEDDING_API_BASE - Base URL for LM Studio's OpenAI-compatible API
 *   EMBEDDING_API_KEY - Bearer token sent to LM Studio (LM Studio ignores
 *     its value, but the header must be present; default "lm-studio")
 *   EMBEDDING_MODEL - Model identifier as loaded in LM Studio (required)
 *   CHAT_API_BASE - Base URL for chat/metadata extraction (defaults to
 *     EMBEDDING_API_BASE)
 *   CHAT_API_KEY - Bearer token for chat calls (defaults to EMBEDDING_API_KEY)
 *   CHAT_MODEL - Model identifier as loaded in LM Studio (required)
 *   MCP_ACCESS_KEY - Authentication key for the MCP endpoint (required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { Pool, Oid } from "postgres";

// --- Configuration ---

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const DB_HOST = Deno.env.get("DB_HOST") || "127.0.0.1";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "postgres";
const DB_PASSWORD = requireEnv("DB_PASSWORD");

const EMBED_DIM = parseInt(Deno.env.get("EMBED_DIM") || "768", 10);

const EMBEDDING_API_BASE = requireEnv("EMBEDDING_API_BASE");
const EMBEDDING_API_KEY = Deno.env.get("EMBEDDING_API_KEY") || "lm-studio";
const EMBEDDING_MODEL = requireEnv("EMBEDDING_MODEL");

const CHAT_API_BASE = Deno.env.get("CHAT_API_BASE") || EMBEDDING_API_BASE;
const CHAT_API_KEY = Deno.env.get("CHAT_API_KEY") || EMBEDDING_API_KEY;
const CHAT_MODEL = requireEnv("CHAT_MODEL");

const MCP_ACCESS_KEY = requireEnv("MCP_ACCESS_KEY");

// --- PostgreSQL Connection Pool ---

const pool = new Pool({
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  controls: { decoders: { [Oid.int8]: (value: string) => value } },
}, 20);

type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
};

// --- Embedding & Metadata Extraction ---

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Embedding API failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  const embedding: number[] = d.data[0].embedding;
  if (embedding.length !== EMBED_DIM) {
    throw new Error(
      `embedding-dim mismatch: got ${embedding.length}, column expects ${EMBED_DIM}. ` +
        `Either EMBEDDING_MODEL produces a different size than EMBED_DIM, or EMBED_DIM ` +
        `was changed after the db volume was initialized — see README.`
    );
  }
  return embedding;
}

// LM Studio's OpenAI-compatible server rejects response_format: { type:
// "json_object" } outright (400: "'response_format.type' must be
// 'json_schema' or 'text'") -- confirmed in the field against
// google/gemma-4-e4b. json_schema is what LM Studio actually implements
// for structured output: https://lmstudio.ai/docs/app/api/structured-output
const METADATA_SCHEMA = {
  type: "object",
  properties: {
    people: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: { type: "string" } },
    dates_mentioned: { type: "array", items: { type: "string" } },
    topics: { type: "array", items: { type: "string" } },
    type: {
      type: "string",
      enum: ["observation", "task", "idea", "reference", "person_note"],
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
        },
        required: ["name", "type"],
        additionalProperties: false,
      },
    },
  },
  required: ["people", "action_items", "dates_mentioned", "topics", "type", "entities"],
  additionalProperties: false,
};

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const fallback = { topics: ["uncategorized"], type: "observation" };

  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "thought_metadata",
          strict: true,
          schema: METADATA_SCHEMA,
        },
      },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
- "entities": array of {name, type} for distinct people/projects/tools/organizations/concepts mentioned (empty if none). "type" is a short freeform label you choose (e.g. "person", "project", "tool") -- not a fixed list.
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.error(`Metadata extraction API failed: ${r.status} ${msg}`);
    return fallback;
  }

  const d = await r.json();
  const raw = d.choices?.[0]?.message?.content;
  if (!raw) {
    console.error(`Metadata extraction: no message content in chat response: ${JSON.stringify(d)}`);
    return fallback;
  }

  // json_schema mode should return clean JSON directly, but a fence-free
  // reply isn't guaranteed across every model LM Studio can serve -- keep
  // the strip as a cheap defensive fallback rather than assuming it's dead.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error(`Metadata extraction: model output wasn't valid JSON: ${cleaned}`);
    return fallback;
  }
}

// --- Connection Graph & Entity Helpers ---

type DbClient = Awaited<ReturnType<typeof pool.connect>>;

const DEDUP_THRESHOLD = 0.9;
const CONNECTION_THRESHOLD = 0.75;
const CONNECTION_CANDIDATE_LIMIT = 5;

const CONNECTION_TYPES = ["extends", "contradicts", "is-evidence-for", "supersedes", "related"] as const;

const CONNECTION_SCHEMA = {
  type: "object",
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate_id: { type: "string" },
          link_type: { type: "string", enum: [...CONNECTION_TYPES] },
        },
        required: ["candidate_id", "link_type"],
        additionalProperties: false,
      },
    },
  },
  required: ["classifications"],
  additionalProperties: false,
};

async function checkDedup(
  client: DbClient,
  embStr: string
): Promise<{ id: string; content: string; similarity: number } | null> {
  const result = await client.queryObject<{ id: string; content: string; similarity: number }>(
    `SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity
     FROM thoughts
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    [embStr]
  );
  const top = result.rows[0];
  if (top && top.similarity >= DEDUP_THRESHOLD) return top;
  return null;
}

async function storeConnections(
  client: DbClient,
  newThoughtId: string,
  newContent: string,
  embStr: string
): Promise<void> {
  const candidates = await client.queryObject<{ id: string; content: string; similarity: number }>(
    `SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity
     FROM thoughts
     WHERE id != $2::bigint AND 1 - (embedding <=> $1::vector) >= $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    [embStr, newThoughtId, CONNECTION_THRESHOLD, CONNECTION_CANDIDATE_LIMIT]
  );

  if (!candidates.rows.length) return;

  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: {
        type: "json_schema",
        json_schema: { name: "connection_types", strict: true, schema: CONNECTION_SCHEMA },
      },
      messages: [
        {
          role: "system",
          content: `Classify the relationship between a NEW thought and each CANDIDATE thought. For each candidate, pick exactly one type: "extends" (new thought adds detail/context to the candidate), "contradicts" (new thought disagrees with or reverses the candidate), "is-evidence-for" (new thought supports/confirms the candidate), "supersedes" (new thought replaces/obsoletes the candidate), or "related" (topically connected but none of the above fit). Return exactly one classification per candidate_id given.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            new_thought: newContent,
            candidates: candidates.rows.map((c) => ({ candidate_id: c.id, content: c.content })),
          }),
        },
      ],
    }),
  });

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.error(`Connection typing API failed: ${r.status} ${msg}`);
    return;
  }

  const d = await r.json();
  const raw = d.choices?.[0]?.message?.content;
  if (!raw) {
    console.error(`Connection typing: no message content in chat response: ${JSON.stringify(d)}`);
    return;
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: { classifications: { candidate_id: string; link_type: string }[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error(`Connection typing: model output wasn't valid JSON: ${cleaned}`);
    return;
  }

  const bySimilarity = new Map(candidates.rows.map((c) => [c.id, c.similarity]));
  for (const cl of parsed.classifications ?? []) {
    const similarity = bySimilarity.get(cl.candidate_id);
    if (similarity === undefined) continue; // model referenced an id not in the candidate set -- skip rather than guess
    await client.queryObject(
      `INSERT INTO thought_connections (source_thought_id, target_thought_id, similarity, link_type)
       VALUES ($1::bigint, $2::bigint, $3, $4)
       ON CONFLICT (source_thought_id, target_thought_id) DO NOTHING`,
      [newThoughtId, cl.candidate_id, similarity, cl.link_type]
    );
  }
}

async function resolveEntities(
  client: DbClient,
  thoughtId: string,
  entities: { name: string; type?: string }[]
): Promise<string[]> {
  const entityIds: string[] = [];
  for (const e of entities) {
    const name = e.name?.trim();
    if (!name) continue;

    const existing = await client.queryObject<{ id: string }>(
      `SELECT id FROM entities WHERE lower(name) = lower($1)`,
      [name]
    );

    let entityId: string;
    if (existing.rows.length) {
      entityId = existing.rows[0].id;
      await client.queryObject(
        `UPDATE entities SET mention_count = mention_count + 1, last_seen_at = now() WHERE id = $1::bigint`,
        [entityId]
      );
    } else {
      const inserted = await client.queryObject<{ id: string }>(
        `INSERT INTO entities (name, type) VALUES ($1, $2) RETURNING id`,
        [name, e.type ?? null]
      );
      entityId = inserted.rows[0].id;
    }

    await client.queryObject(
      `INSERT INTO thought_entities (thought_id, entity_id) VALUES ($1::bigint, $2::bigint)
       ON CONFLICT (thought_id, entity_id) DO NOTHING`,
      [thoughtId, entityId]
    );
    entityIds.push(entityId);
  }
  return entityIds;
}

async function storeEntityBridges(
  client: DbClient,
  thoughtId: string,
  entityIds: string[],
  embStr: string
): Promise<void> {
  if (entityIds.length < 2) return; // need >=2 shared entities to count as a bridge, per spec

  const bridges = await client.queryObject<{ other_thought_id: string }>(
    `SELECT te.thought_id AS other_thought_id
     FROM thought_entities te
     WHERE te.entity_id = ANY($1::bigint[]) AND te.thought_id != $2::bigint
     GROUP BY te.thought_id
     HAVING COUNT(*) >= 2`,
    [entityIds, thoughtId]
  );

  for (const b of bridges.rows) {
    await client.queryObject(
      `INSERT INTO thought_connections (source_thought_id, target_thought_id, similarity, link_type)
       SELECT $1::bigint, $2::bigint, 1 - (embedding <=> $3::vector), 'shares_entities'
       FROM thoughts WHERE id = $2::bigint
       ON CONFLICT (source_thought_id, target_thought_id) DO NOTHING`,
      [thoughtId, b.other_thought_id, embStr]
    );
  }
}

// --- MCP Server Setup ---

function buildServer(): McpServer {
  const server = new McpServer({
    name: "open-brain-lmstudio",
    version: "1.0.0",
  });

  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        const qEmb = await getEmbedding(query);
        const embStr = `[${qEmb.join(",")}]`;

        const client = await pool.connect();
        try {
          const result = await client.queryObject<ThoughtMatch>(
            `SELECT id, content, metadata, created_at,
                    1 - (embedding <=> $1::vector) AS similarity
             FROM thoughts
             WHERE 1 - (embedding <=> $1::vector) >= $2
             ORDER BY embedding <=> $1::vector
             LIMIT $3`,
            [embStr, threshold, limit]
          );

          if (!result.rows.length) {
            return {
              content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
            };
          }

          const results = result.rows.map((t, i) => {
            const m = t.metadata || {};
            const parts = [
              `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
              `ID: ${t.id}`,
              `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
              `Type: ${m.type || "unknown"}`,
            ];
            if (Array.isArray(m.topics) && m.topics.length)
              parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
            if (Array.isArray(m.people) && m.people.length)
              parts.push(`People: ${(m.people as string[]).join(", ")}`);
            if (Array.isArray(m.action_items) && m.action_items.length)
              parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
            parts.push(`\n${t.content}`);
            return parts.join("\n");
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${result.rows.length} thought(s):\n\n${results.join("\n\n")}`,
              },
            ],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description:
        "List recently captured thoughts with optional filters by type, topic, person, or time range.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        limit: z.number().optional().default(10),
        type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().optional().describe("Only thoughts from the last N days"),
      },
    },
    async ({ limit, type, topic, person, days }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (type) {
          conditions.push(`metadata->>'type' = $${paramIdx}`);
          params.push(type);
          paramIdx++;
        }
        if (topic) {
          conditions.push(`metadata->'topics' ? $${paramIdx}`);
          params.push(topic);
          paramIdx++;
        }
        if (person) {
          conditions.push(`metadata->'people' ? $${paramIdx}`);
          params.push(person);
          paramIdx++;
        }
        if (days) {
          conditions.push(`created_at >= NOW() - INTERVAL '${days} days'`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const client = await pool.connect();
        try {
          const result = await client.queryObject<{
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          }>(
            `SELECT id, content, metadata, created_at
             FROM thoughts
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${paramIdx}`,
            [...params, limit]
          );

          if (!result.rows.length) {
            return { content: [{ type: "text" as const, text: "No thoughts found." }] };
          }

          const results = result.rows.map((t, i) => {
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
            return `${i + 1}. (id ${t.id}) [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `${result.rows.length} recent thought(s):\n\n${results.join("\n\n")}`,
              },
            ],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const client = await pool.connect();
        try {
          const countResult = await client.queryObject<{ count: number }>(
            "SELECT COUNT(*)::int AS count FROM thoughts"
          );

          const dataResult = await client.queryObject<{
            metadata: Record<string, unknown>;
            created_at: string;
          }>(
            "SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC"
          );

          const count = countResult.rows[0]?.count || 0;
          const data = dataResult.rows;

          const types: Record<string, number> = {};
          const topics: Record<string, number> = {};
          const people: Record<string, number> = {};

          for (const r of data) {
            const m = r.metadata || {};
            if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
            if (Array.isArray(m.topics))
              for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
            if (Array.isArray(m.people))
              for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
          }

          const sort = (o: Record<string, number>): [string, number][] =>
            Object.entries(o)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10);

          const lines: string[] = [
            `Total thoughts: ${count}`,
            `Date range: ${
              data.length
                ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
                  " -> " +
                  new Date(data[0].created_at).toLocaleDateString()
                : "N/A"
            }`,
            "",
            "Types:",
            ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
          ];

          if (Object.keys(topics).length) {
            lines.push("", "Top topics:");
            for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
          }

          if (Object.keys(people).length) {
            lines.push("", "People mentioned:");
            for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. " +
        "If this returns a duplicate-skip notice, delegate the decision to a fresh Haiku subagent: hand it the new content and the flagged existing thought, and have it decide (amend the existing one via update_thought, or force-recapture) from that evidence alone. If the evidence doesn't clearly favor one option, ask the user rather than guessing.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        content: z.string().describe("The thought to capture"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Skip the duplicate check and capture unconditionally, even if a near-identical thought already exists."
          ),
      },
    },
    async ({ content, force }) => {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);

        const embStr = `[${embedding.join(",")}]`;

        const client = await pool.connect();
        try {
          if (!force) {
            const dup = await checkDedup(client, embStr);
            if (dup) {
              const excerpt = dup.content.length > 120 ? dup.content.slice(0, 120) + "..." : dup.content;
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Skipped -- nearly identical to thought #${dup.id} (${(dup.similarity * 100).toFixed(1)}% similar): "${excerpt}". Call update_thought on #${dup.id} to amend it, or capture_thought again with force: true to capture as a new entry anyway.`,
                  },
                ],
              };
            }
          }

          const meta: Record<string, unknown> = { ...metadata, source: "mcp" };
          const entities = Array.isArray(meta.entities)
            ? (meta.entities as { name: string; type?: string }[])
            : [];
          delete meta.entities; // stored relationally (thought_entities), not duplicated into metadata jsonb

          const inserted = await client.queryObject<{ id: string }>(
            `INSERT INTO thoughts (content, embedding, metadata)
             VALUES ($1, $2::vector, $3::jsonb)
             RETURNING id`,
            [content, embStr, JSON.stringify(meta)]
          );
          const newId = inserted.rows[0].id;

          // Graph enrichment must never turn a successful insert into a
          // reported failure -- a hiccup here is much lower-stakes than a
          // false "your capture failed" message.
          try {
            await storeConnections(client, newId, content, embStr);
            const entityIds = await resolveEntities(client, newId, entities);
            await storeEntityBridges(client, newId, entityIds, embStr);
          } catch (graphErr: unknown) {
            console.error(
              `Graph enrichment failed for thought ${newId} (capture itself succeeded): ${(graphErr as Error).message}`
            );
          }

          let confirmation = `Captured as ${meta.type || "thought"}`;
          if (Array.isArray(meta.topics) && meta.topics.length)
            confirmation += ` -- ${(meta.topics as string[]).join(", ")}`;
          if (Array.isArray(meta.people) && meta.people.length)
            confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
          if (Array.isArray(meta.action_items) && meta.action_items.length)
            confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

          return {
            content: [{ type: "text" as const, text: confirmation }],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "update_thought",
    {
      title: "Update Thought Metadata",
      description:
        "Patch a captured thought's metadata in place -- merges the given fields into its existing metadata (e.g. to fix a wrong type or add a missing topic). Content and embedding are never touched. Use the id shown in search_thoughts/list_thoughts output.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        id: z.string().describe("Thought id, as shown in search_thoughts/list_thoughts output"),
        metadata: z
          .record(z.string(), z.unknown())
          .describe(
            'Fields to merge into existing metadata, e.g. {"type": "task", "topics": ["homelab"]}. ' +
              "Only the given keys are changed; anything else already on the thought is left as-is."
          ),
      },
    },
    async ({ id, metadata }) => {
      try {
        const client = await pool.connect();
        try {
          const result = await client.queryObject<{ id: string; metadata: Record<string, unknown> }>(
            `UPDATE thoughts SET metadata = metadata || $2::jsonb WHERE id = $1::bigint RETURNING id, metadata`,
            [id, JSON.stringify(metadata)]
          );

          if (!result.rows.length) {
            return {
              content: [{ type: "text" as const, text: `No thought found with id ${id}.` }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Updated thought ${id}. Metadata is now: ${JSON.stringify(result.rows[0].metadata)}`,
              },
            ],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "delete_thought",
    {
      title: "Delete Thought",
      description:
        "Permanently delete a captured thought by id. This cannot be undone. Use the id shown in search_thoughts/list_thoughts output.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        id: z.string().describe("Thought id, as shown in search_thoughts/list_thoughts output"),
      },
    },
    async ({ id }) => {
      try {
        const client = await pool.connect();
        try {
          const result = await client.queryObject<{ id: string }>(
            `DELETE FROM thoughts WHERE id = $1::bigint RETURNING id`,
            [id]
          );

          if (!result.rows.length) {
            return {
              content: [{ type: "text" as const, text: `No thought found with id ${id} -- nothing deleted.` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text" as const, text: `Deleted thought ${id}.` }],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_connections",
    {
      title: "Get Connections",
      description:
        "Show every connection a thought has to other thoughts (typed edges: extends, contradicts, is-evidence-for, supersedes, related, shares_entities), in either direction. Use the id shown in search_thoughts/list_thoughts output.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        thought_id: z.string().describe("Thought id, as shown in search_thoughts/list_thoughts output"),
      },
    },
    async ({ thought_id }) => {
      try {
        const client = await pool.connect();
        try {
          const result = await client.queryObject<{
            other_id: string;
            other_content: string;
            link_type: string;
            similarity: number;
          }>(
            `SELECT c.other_id, t.content AS other_content, c.link_type, c.similarity
             FROM (
               SELECT target_thought_id AS other_id, link_type, similarity
               FROM thought_connections WHERE source_thought_id = $1::bigint
               UNION ALL
               SELECT source_thought_id AS other_id, link_type, similarity
               FROM thought_connections WHERE target_thought_id = $1::bigint
             ) c
             JOIN thoughts t ON t.id = c.other_id
             ORDER BY c.similarity DESC`,
            [thought_id]
          );

          if (!result.rows.length) {
            return { content: [{ type: "text" as const, text: `No connections found for thought ${thought_id}.` }] };
          }

          const lines = result.rows.map(
            (r, i) =>
              `${i + 1}. [${r.link_type}] (id ${r.other_id}, ${(r.similarity * 100).toFixed(1)}% similar)\n   ${r.other_content}`
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `${result.rows.length} connection(s) for thought ${thought_id}:\n\n${lines.join("\n\n")}`,
              },
            ],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_entities",
    {
      title: "List Entities",
      description:
        "Browse entities (people/projects/tools/concepts) mentioned across captured thoughts, ordered by how often they're mentioned.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        type: z.string().optional().describe("Filter by entity type (freeform, e.g. 'person', 'project')"),
        limit: z.number().optional().default(20),
      },
    },
    async ({ type, limit }) => {
      try {
        const client = await pool.connect();
        try {
          const conditions: string[] = [];
          const params: unknown[] = [];
          let paramIdx = 1;
          if (type) {
            conditions.push(`lower(type) = lower($${paramIdx})`);
            params.push(type);
            paramIdx++;
          }
          const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

          const result = await client.queryObject<{
            id: string;
            name: string;
            type: string | null;
            mention_count: number;
            last_seen_at: string;
          }>(
            `SELECT id, name, type, mention_count, last_seen_at
             FROM entities
             ${whereClause}
             ORDER BY mention_count DESC
             LIMIT $${paramIdx}`,
            [...params, limit]
          );

          if (!result.rows.length) {
            return { content: [{ type: "text" as const, text: "No entities found." }] };
          }

          const lines = result.rows.map(
            (e, i) =>
              `${i + 1}. ${e.name} (${e.type || "unknown type"}) -- mentioned ${e.mention_count}x, last seen ${new Date(e.last_seen_at).toLocaleDateString()}`
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `${result.rows.length} entit${result.rows.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n")}`,
              },
            ],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "review_stale",
    {
      title: "Review Stale Thoughts",
      description:
        "List old, weakly-connected thoughts that may be worth cleaning up. " +
        "Delegate judgment to a fresh Haiku subagent per candidate: decide keep, update, or delete from the content and connection count alone. If the evidence doesn't clearly support an action, ask the user before deleting or amending anything.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        days: z.number().optional().default(90).describe("Only thoughts older than this many days"),
        max_connections: z.number().optional().default(1).describe("Only thoughts with fewer than this many connections"),
        limit: z.number().optional().default(20),
      },
    },
    async ({ days, max_connections, limit }) => {
      try {
        const client = await pool.connect();
        try {
          const result = await client.queryObject<{
            id: string;
            content: string;
            created_at: string;
            connection_count: number;
          }>(
            `SELECT t.id, t.content, t.created_at, COUNT(c.id)::int AS connection_count
             FROM thoughts t
             LEFT JOIN thought_connections c ON c.source_thought_id = t.id OR c.target_thought_id = t.id
             WHERE t.created_at < now() - make_interval(days => $1::int)
             GROUP BY t.id, t.content, t.created_at
             HAVING COUNT(c.id) < $2
             ORDER BY t.created_at ASC
             LIMIT $3`,
            [days, max_connections, limit]
          );

          if (!result.rows.length) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No stale thoughts found (older than ${days} days, fewer than ${max_connections} connections).`,
                },
              ],
            };
          }

          const lines = result.rows.map(
            (t, i) =>
              `${i + 1}. (id ${t.id}) captured ${new Date(t.created_at).toLocaleDateString()}, ${t.connection_count} connection(s)\n   ${t.content}`
          );

          return {
            content: [
              { type: "text" as const, text: `${result.rows.length} stale candidate(s):\n\n${lines.join("\n\n")}` },
            ],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "dedup_review",
    {
      title: "Dedup Review",
      description:
        "Scan existing thoughts for pairs that may be duplicates but weren't caught at capture time (similarity between 75% and 90% -- below the auto-flag threshold, above merely related). " +
        "Delegate judgment to a fresh Haiku subagent per candidate pair: it should decide duplicate or not duplicate from the two contents and similarity score alone. If a pair's evidence is ambiguous, ask the user rather than guessing.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        days: z.number().optional().describe("Only scan thoughts captured in the last N days (omit to scan everything)"),
        limit: z.number().optional().default(20),
      },
    },
    async ({ days, limit }) => {
      try {
        const client = await pool.connect();
        try {
          const result = await client.queryObject<{
            id_a: string;
            content_a: string;
            id_b: string;
            content_b: string;
            similarity: number;
          }>(
            `SELECT a.id AS id_a, a.content AS content_a, b.id AS id_b, b.content AS content_b,
                    1 - (a.embedding <=> b.embedding) AS similarity
             FROM thoughts a
             JOIN thoughts b ON b.id > a.id
             WHERE 1 - (a.embedding <=> b.embedding) BETWEEN 0.75 AND 0.90
               AND ($1::int IS NULL OR a.created_at > now() - make_interval(days => $1::int))
             ORDER BY similarity DESC
             LIMIT $2`,
            [days ?? null, limit]
          );

          if (!result.rows.length) {
            return { content: [{ type: "text" as const, text: "No possible-duplicate pairs found in that range." }] };
          }

          const lines = result.rows.map(
            (r, i) =>
              `${i + 1}. (${(r.similarity * 100).toFixed(1)}% similar) #${r.id_a} vs #${r.id_b}\n   A: ${r.content_a}\n   B: ${r.content_b}`
          );

          return {
            content: [
              { type: "text" as const, text: `${result.rows.length} possible duplicate pair(s):\n\n${lines.join("\n\n")}` },
            ],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "serendipity_digest",
    {
      title: "Serendipity Digest",
      description:
        "Surface a few potentially interesting thoughts: one rediscovered (old, weakly connected), one orphaned (zero connections), one recent echo (a recent thought connected to something much older). " +
        "Delegate the write-up to a fresh Haiku subagent: give it the raw data and have it write the framing. If it can't tell why a slot is interesting from the data alone, say so plainly rather than inventing a narrative.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const client = await pool.connect();
        try {
          const rediscovery = await client.queryObject<{ id: string; content: string; created_at: string }>(
            `SELECT t.id, t.content, t.created_at
             FROM thoughts t
             LEFT JOIN thought_connections c ON c.source_thought_id = t.id OR c.target_thought_id = t.id
             WHERE t.created_at < now() - make_interval(days => 30)
             GROUP BY t.id, t.content, t.created_at
             HAVING COUNT(c.id) <= 1
             ORDER BY random()
             LIMIT 1`
          );

          const orphan = await client.queryObject<{ id: string; content: string; created_at: string }>(
            `SELECT t.id, t.content, t.created_at
             FROM thoughts t
             WHERE NOT EXISTS (
               SELECT 1 FROM thought_connections c
               WHERE c.source_thought_id = t.id OR c.target_thought_id = t.id
             )
             ORDER BY random()
             LIMIT 1`
          );

          // Relies on the directionality invariant (see plan Global
          // Constraints): source_thought_id is always the newer thought
          // in a connection row, so "new connects to something 30+ days
          // older" is a direct filter, not a computed direction.
          const recentEcho = await client.queryObject<{
            new_id: string;
            new_content: string;
            old_id: string;
            old_content: string;
            days_apart: number;
          }>(
            `SELECT nt.id AS new_id, nt.content AS new_content, ot.id AS old_id, ot.content AS old_content,
                    EXTRACT(DAY FROM nt.created_at - ot.created_at)::int AS days_apart
             FROM thought_connections c
             JOIN thoughts nt ON nt.id = c.source_thought_id
             JOIN thoughts ot ON ot.id = c.target_thought_id
             WHERE nt.created_at > now() - make_interval(days => 7)
               AND nt.created_at - ot.created_at > make_interval(days => 30)
             ORDER BY nt.created_at DESC
             LIMIT 1`
          );

          const parts: string[] = [];
          if (rediscovery.rows.length) {
            const r = rediscovery.rows[0];
            parts.push(
              `REDISCOVERY (id ${r.id}, captured ${new Date(r.created_at).toLocaleDateString()}):\n${r.content}`
            );
          }
          if (orphan.rows.length) {
            const o = orphan.rows[0];
            parts.push(
              `ORPHAN (id ${o.id}, captured ${new Date(o.created_at).toLocaleDateString()}, zero connections):\n${o.content}`
            );
          }
          if (recentEcho.rows.length) {
            const e = recentEcho.rows[0];
            parts.push(
              `RECENT ECHO (${e.days_apart} days apart):\n  New (id ${e.new_id}): ${e.new_content}\n  Old (id ${e.old_id}): ${e.old_content}`
            );
          }

          if (!parts.length) {
            return {
              content: [
                { type: "text" as const, text: "Nothing to surface yet -- not enough thoughts/connections for a digest." },
              ],
            };
          }

          return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "weekly_review",
    {
      title: "Weekly Review",
      description:
        "Return raw activity data for a time window: new thoughts by type/topic, new connections created, stale candidates, and top entities mentioned. " +
        "Delegate synthesis to a fresh Haiku subagent: give it this data and have it write the narrative review. It should stick to what the evidence supports and flag gaps rather than filling them in.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {
        days: z.number().optional().default(7),
      },
    },
    async ({ days }) => {
      try {
        const client = await pool.connect();
        try {
          const newThoughts = await client.queryObject<{
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          }>(
            `SELECT id, content, metadata, created_at
             FROM thoughts
             WHERE created_at > now() - make_interval(days => $1::int)
             ORDER BY created_at DESC`,
            [days]
          );

          const newConnections = await client.queryObject<{
            source_thought_id: string;
            target_thought_id: string;
            link_type: string;
          }>(
            `SELECT source_thought_id, target_thought_id, link_type
             FROM thought_connections
             WHERE created_at > now() - make_interval(days => $1::int)`,
            [days]
          );

          const staleCandidates = await client.queryObject<{ id: string; content: string; connection_count: number }>(
            `SELECT t.id, t.content, COUNT(c.id)::int AS connection_count
             FROM thoughts t
             LEFT JOIN thought_connections c ON c.source_thought_id = t.id OR c.target_thought_id = t.id
             WHERE t.created_at < now() - make_interval(days => 90)
             GROUP BY t.id, t.content
             HAVING COUNT(c.id) < 1
             ORDER BY t.id
             LIMIT 10`
          );

          const topEntities = await client.queryObject<{ name: string; mention_count: number }>(
            `SELECT e.name, COUNT(*)::int AS mention_count
             FROM thought_entities te
             JOIN entities e ON e.id = te.entity_id
             JOIN thoughts t ON t.id = te.thought_id
             WHERE t.created_at > now() - make_interval(days => $1::int)
             GROUP BY e.name
             ORDER BY mention_count DESC
             LIMIT 10`,
            [days]
          );

          const types: Record<string, number> = {};
          const topics: Record<string, number> = {};
          for (const t of newThoughts.rows) {
            const m = t.metadata || {};
            if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
            if (Array.isArray(m.topics))
              for (const tp of m.topics) topics[tp as string] = (topics[tp as string] || 0) + 1;
          }

          const payload = {
            window_days: days,
            new_thought_count: newThoughts.rows.length,
            types,
            topics,
            new_connections: newConnections.rows,
            stale_candidates: staleCandidates.rows,
            top_entities_this_window: topEntities.rows,
            thoughts: newThoughts.rows.map((t) => ({
              id: t.id,
              content: t.content,
              metadata: t.metadata,
              created_at: t.created_at,
            })),
          };

          return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "analyze",
    {
      title: "Analyze Graph",
      description:
        "Live-computed stats about the connection graph: total connections, most-connected thoughts, link type distribution, most-mentioned entities, and most-common entity co-occurrence pairs.",
      annotations: {
        readOnlyHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const client = await pool.connect();
        try {
          const totals = await client.queryObject<{ total_connections: number; total_entities: number }>(
            `SELECT
               (SELECT COUNT(*)::int FROM thought_connections) AS total_connections,
               (SELECT COUNT(*)::int FROM entities) AS total_entities`
          );

          const hubs = await client.queryObject<{ id: string; content: string; connection_count: number }>(
            `SELECT t.id, t.content, COUNT(c.id)::int AS connection_count
             FROM thoughts t
             JOIN thought_connections c ON c.source_thought_id = t.id OR c.target_thought_id = t.id
             GROUP BY t.id, t.content
             ORDER BY connection_count DESC
             LIMIT 5`
          );

          const linkTypes = await client.queryObject<{ link_type: string; count: number }>(
            `SELECT link_type, COUNT(*)::int AS count
             FROM thought_connections
             GROUP BY link_type
             ORDER BY count DESC`
          );

          const topEntities = await client.queryObject<{ name: string; type: string | null; mention_count: number }>(
            `SELECT name, type, mention_count FROM entities ORDER BY mention_count DESC LIMIT 10`
          );

          const coOccurrence = await client.queryObject<{ entity_a: string; entity_b: string; co_count: number }>(
            `SELECT ea.name AS entity_a, eb.name AS entity_b, COUNT(*)::int AS co_count
             FROM thought_entities tea
             JOIN thought_entities teb ON teb.thought_id = tea.thought_id AND teb.entity_id > tea.entity_id
             JOIN entities ea ON ea.id = tea.entity_id
             JOIN entities eb ON eb.id = teb.entity_id
             GROUP BY ea.name, eb.name
             ORDER BY co_count DESC
             LIMIT 5`
          );

          const lines: string[] = [
            `Total connections: ${totals.rows[0]?.total_connections ?? 0}`,
            `Total entities: ${totals.rows[0]?.total_entities ?? 0}`,
            "",
            "Link type distribution:",
            ...linkTypes.rows.map((l) => `  ${l.link_type}: ${l.count}`),
          ];

          if (hubs.rows.length) {
            lines.push("", "Most-connected thoughts:");
            for (const h of hubs.rows) lines.push(`  (id ${h.id}, ${h.connection_count} connections) ${h.content.slice(0, 80)}`);
          }

          if (topEntities.rows.length) {
            lines.push("", "Top entities:");
            for (const e of topEntities.rows) lines.push(`  ${e.name} (${e.type || "unknown"}): ${e.mention_count} mentions`);
          }

          if (coOccurrence.rows.length) {
            lines.push("", "Most-common entity pairs:");
            for (const p of coOccurrence.rows) lines.push(`  ${p.entity_a} + ${p.entity_b}: ${p.co_count} thought(s)`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// --- Hono App with Auth Check ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

// Unauthenticated on purpose, like any liveness/readiness endpoint -- it
// only reports whether Postgres is reachable, no application data.
app.get("/health", async (c) => {
  try {
    const client = await pool.connect();
    try {
      await client.queryObject("SELECT 1");
    } finally {
      client.release();
    }
    return c.text("ok", 200);
  } catch (err: unknown) {
    return c.text(`db unreachable: ${(err as Error).message}`, 503);
  }
});

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  // Reject non-POST requests up front. This server is stateless over
  // streamable HTTP: there is no standalone SSE stream (GET) or session
  // termination (DELETE) to serve. Without this guard a GET falls through to
  // StreamableHTTPTransport.handleRequest, which parks it on an SSE stream
  // that never emits and never closes.
  if (c.req.method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405, { ...corsHeaders, Allow: "POST, OPTIONS" });
  }

  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  // Claude Desktop connectors don't send Accept: text/event-stream — patch it in.
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const server = buildServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  if (!response) return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
  response.headers.delete("mcp-session-id");
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
});

Deno.serve({ port: parseInt(Deno.env.get("PORT") || "8000", 10) }, app.fetch);
