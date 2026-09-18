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
import { Pool } from "postgres";

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
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
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

  // response_format: json_object doesn't guarantee a fence-free reply from
  // every model -- some still wrap the JSON in a ```json ... ``` block, which
  // JSON.parse rejects outright. Strip it before parsing rather than losing
  // real extractions to this every time.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error(`Metadata extraction: model output wasn't valid JSON: ${cleaned}`);
    return fallback;
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
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          }>(
            `SELECT content, metadata, created_at
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
            return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
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
        "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        content: z.string().describe("The thought to capture"),
      },
    },
    async ({ content }) => {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);

        const embStr = `[${embedding.join(",")}]`;
        const meta: Record<string, unknown> = { ...metadata, source: "mcp" };

        const client = await pool.connect();
        try {
          await client.queryObject(
            `INSERT INTO thoughts (content, embedding, metadata)
             VALUES ($1, $2::vector, $3::jsonb)`,
            [content, embStr, JSON.stringify(meta)]
          );
        } finally {
          client.release();
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
