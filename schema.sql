CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ancestors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  gedcom_xref TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  given_name TEXT,
  surname TEXT,
  sex CHAR(1),
  birth_date TEXT,
  birth_place TEXT,
  death_date TEXT,
  death_place TEXT,
  burial_place TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ancestor_relationships (
  parent_id UUID REFERENCES ancestors(id) ON DELETE CASCADE,
  child_id UUID REFERENCES ancestors(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS ancestors_name_trgm_idx
  ON ancestors USING gin (name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ancestors_surname_idx
  ON ancestors (surname);

CREATE INDEX IF NOT EXISTS ancestors_gedcom_xref_idx
  ON ancestors (gedcom_xref);

CREATE OR REPLACE FUNCTION trace_lineage(
  start_id UUID,
  max_generations INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  given_name TEXT,
  surname TEXT,
  sex CHAR(1),
  birth_date TEXT,
  birth_place TEXT,
  death_date TEXT,
  death_place TEXT,
  generation INT
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT
      a.id, a.name, a.given_name, a.surname, a.sex,
      a.birth_date, a.birth_place, a.death_date, a.death_place,
      0 AS generation
    FROM ancestors a
    WHERE a.id = start_id

    UNION ALL

    SELECT
      a.id, a.name, a.given_name, a.surname, a.sex,
      a.birth_date, a.birth_place, a.death_date, a.death_place,
      l.generation + 1
    FROM ancestors a
    JOIN ancestor_relationships r ON r.parent_id = a.id
    JOIN lineage l ON l.id = r.child_id
    WHERE l.generation < max_generations
  )
  SELECT * FROM lineage ORDER BY generation, name;
$$;

-- ─── Ancestor Notes (with embeddings) ────────────────────

CREATE TABLE IF NOT EXISTS ancestor_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ancestor_id UUID REFERENCES ancestors(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ancestor_notes_embedding_hnsw_idx
  ON ancestor_notes USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS ancestor_notes_metadata_gin_idx
  ON ancestor_notes USING gin (metadata);

CREATE INDEX IF NOT EXISTS ancestor_notes_ancestor_id_idx
  ON ancestor_notes (ancestor_id);

CREATE INDEX IF NOT EXISTS ancestor_notes_created_at_desc_idx
  ON ancestor_notes (created_at DESC);

CREATE OR REPLACE FUNCTION update_ancestor_notes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ancestor_notes_updated_at ON ancestor_notes;
CREATE TRIGGER ancestor_notes_updated_at
  BEFORE UPDATE ON ancestor_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_ancestor_notes_updated_at();

CREATE OR REPLACE FUNCTION match_ancestor_notes(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  p_ancestor_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  ancestor_id UUID,
  ancestor_name TEXT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    n.id,
    n.ancestor_id,
    a.name AS ancestor_name,
    n.content,
    n.metadata,
    (1 - (n.embedding <=> query_embedding))::FLOAT AS similarity,
    n.created_at
  FROM ancestor_notes n
  LEFT JOIN ancestors a ON a.id = n.ancestor_id
  WHERE 1 - (n.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR n.metadata @> filter)
    AND (p_ancestor_id IS NULL OR n.ancestor_id = p_ancestor_id)
  ORDER BY n.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
