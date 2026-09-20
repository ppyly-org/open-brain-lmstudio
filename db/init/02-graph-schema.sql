-- Open Brain (LM Studio edition) — connection graph + entity tracking
-- Not templated (no vector columns) -- runs directly, unlike
-- 01-init.sql.template which needs EMBED_DIM substitution first.
-- Runs after 01-init.sql.template's rendered output: docker's official
-- postgres entrypoint processes docker-entrypoint-initdb.d/*.sh and
-- *.sql files in filename-sorted order, and 00-render-init.sh (which
-- renders+runs 01-init.sql.template itself) sorts before this file.

CREATE TABLE IF NOT EXISTS entities (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT,
    mention_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS thought_entities (
    thought_id BIGINT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (thought_id, entity_id)
);

CREATE TABLE IF NOT EXISTS thought_connections (
    id BIGSERIAL PRIMARY KEY,
    source_thought_id BIGINT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    target_thought_id BIGINT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    link_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_thought_id, target_thought_id)
);

CREATE INDEX IF NOT EXISTS idx_thought_entities_entity ON thought_entities (entity_id);
CREATE INDEX IF NOT EXISTS idx_connections_source ON thought_connections (source_thought_id);
CREATE INDEX IF NOT EXISTS idx_connections_target ON thought_connections (target_thought_id);
