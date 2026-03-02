-- ============================================================
-- Fix: IVFFlat probes in match_chunks
-- ============================================================
--
-- PROBLEM: With only ~888 chunks and lists=100, the IVFFlat index
-- default probes=1 searches ~9 chunks (1 cluster). For metadata
-- queries (catalog, biography), the correct chunks may be in a
-- different cluster and are never found — returning 0 results even
-- when the chunk has similarity=0.57 at full scan.
--
-- Root cause confirmed via debug-retrieval.ts:
--   "qual o livro mais antigo de dowbor"
--   threshold=0.4 → 0 results
--   threshold=0.0 → dowbor-books chunk #1 at sim=0.5664
--
-- FIX: SET LOCAL ivfflat.probes = 10 before the query.
-- With lists=100 and ~888 chunks, probes=10 searches ~10% of all
-- clusters (≈88 chunks), giving exact-quality results for our scale.
-- ============================================================

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
  -- Increase probe count: with lists=100 and ~888 chunks, probes=10
  -- effectively searches the entire dataset accurately.
  SET LOCAL ivfflat.probes = 10;

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
