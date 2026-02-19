-- ============================================================
-- Phase 0: Initial Schema — Assistente de Pesquisa Dowbor.org
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Table: books ────────────────────────────────────────────────────────────
-- One row per book version. Re-indexing creates a new row; old rows are
-- deactivated (is_active = false) rather than deleted.

CREATE TABLE IF NOT EXISTS books (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  author       TEXT,
  pdf_hash     TEXT NOT NULL,
  total_pages  INTEGER,
  total_chunks INTEGER,
  indexed_at   TIMESTAMPTZ DEFAULT NOW(),
  is_active    BOOLEAN DEFAULT FALSE,

  -- Slug is stable across versions; uniqueness is enforced per active version
  -- via application logic, not a DB constraint (to allow parallel re-indexing).
  CONSTRAINT books_slug_hash_unique UNIQUE (slug, pdf_hash)
);

CREATE INDEX IF NOT EXISTS idx_books_slug ON books(slug);
CREATE INDEX IF NOT EXISTS idx_books_is_active ON books(is_active);

-- ─── Table: chunks ───────────────────────────────────────────────────────────
-- One row per text chunk. Embeddings stored as pgvector vector(1536).
-- Deduplication enforced via UNIQUE(book_id, chunk_hash).

CREATE TABLE IF NOT EXISTS chunks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id        UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  chunk_hash     TEXT NOT NULL,
  content        TEXT NOT NULL,
  embedding      VECTOR(1536),
  page_number    INTEGER,
  section_title  TEXT,
  token_count    INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chunks_book_hash_unique UNIQUE (book_id, chunk_hash)
);

-- IVFFlat index for approximate nearest-neighbor cosine similarity search.
-- lists = 100 is appropriate for up to ~40,000 chunks (sqrt(40000) ≈ 200; 100 is conservative).
-- Rebuild with higher lists value if total chunks exceeds 100,000.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_chunks_book_id ON chunks(book_id);
CREATE INDEX IF NOT EXISTS idx_chunks_chunk_hash ON chunks(chunk_hash);

-- ─── Table: ingestion_runs ───────────────────────────────────────────────────
-- Full audit trail for every ingestion operation. Used for resumability
-- and observability.

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id                     UUID REFERENCES books(id) ON DELETE SET NULL,
  started_at                  TIMESTAMPTZ DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  status                      TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  chunks_processed            INTEGER DEFAULT 0,
  chunks_skipped              INTEGER DEFAULT 0,
  last_processed_chunk_index  INTEGER DEFAULT -1,
  error_message               TEXT,
  pdf_hash                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_book_id ON ingestion_runs(book_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON ingestion_runs(status);

-- ─── Table: search_logs ──────────────────────────────────────────────────────
-- Observability: one row per search request. Used for debugging,
-- cost tracking, and quality monitoring.

CREATE TABLE IF NOT EXISTS search_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text            TEXT NOT NULL,
  book_ids_filter       TEXT[],
  results_count         INTEGER NOT NULL DEFAULT 0,
  top_similarity        FLOAT,
  latency_embedding_ms  INTEGER,
  latency_retrieval_ms  INTEGER,
  latency_llm_ms        INTEGER,
  latency_total_ms      INTEGER,
  llm_model             TEXT,
  answer_tokens         INTEGER,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_logs_created_at ON search_logs(created_at DESC);

-- ─── RPC Function: match_chunks ──────────────────────────────────────────────
-- Vector similarity search. Called from the backend via supabase.rpc().
-- All ranking and filtering happens server-side; no embeddings cross the wire.

CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding    VECTOR(1536),
  match_count        INT DEFAULT 5,
  book_ids           UUID[] DEFAULT NULL,
  similarity_threshold FLOAT DEFAULT 0.75
)
RETURNS TABLE (
  id             UUID,
  book_id        UUID,
  book_slug      TEXT,
  book_title     TEXT,
  content        TEXT,
  page_number    INTEGER,
  section_title  TEXT,
  similarity     FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.book_id,
    b.slug         AS book_slug,
    b.title        AS book_title,
    c.content,
    c.page_number,
    c.section_title,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM chunks c
  JOIN books b ON b.id = c.book_id
  WHERE
    b.is_active = TRUE
    AND (book_ids IS NULL OR c.book_id = ANY(book_ids))
    AND 1 - (c.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ─── Verification Queries (run manually to confirm schema is correct) ─────────
-- SELECT * FROM pg_extension WHERE extname = 'vector';
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- SELECT proname FROM pg_proc WHERE proname = 'match_chunks';
