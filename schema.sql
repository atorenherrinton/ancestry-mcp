CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
