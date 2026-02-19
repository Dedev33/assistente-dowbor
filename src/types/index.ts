// ─── Database Row Types ────────────────────────────────────────────────────────

export interface Book {
  id: string
  slug: string
  title: string
  author: string | null
  pdf_hash: string
  total_pages: number | null
  total_chunks: number | null
  indexed_at: string
  is_active: boolean
}

export interface Chunk {
  id: string
  book_id: string
  chunk_index: number
  chunk_hash: string
  content: string
  embedding?: number[]
  page_number: number | null
  section_title: string | null
  token_count: number | null
  created_at: string
}

export interface IngestionRun {
  id: string
  book_id: string
  started_at: string
  completed_at: string | null
  status: 'running' | 'completed' | 'failed'
  chunks_processed: number
  chunks_skipped: number
  error_message: string | null
  pdf_hash: string
  last_processed_chunk_index: number
}

export interface SearchLog {
  id: string
  query_text: string
  book_ids_filter: string[] | null
  results_count: number
  top_similarity: number | null
  latency_embedding_ms: number | null
  latency_retrieval_ms: number | null
  latency_llm_ms: number | null
  latency_total_ms: number | null
  llm_model: string | null
  answer_tokens: number | null
  created_at: string
}

// ─── Search / RAG Types ────────────────────────────────────────────────────────

export interface SearchResult {
  id: string
  book_id: string
  book_slug: string
  book_title: string
  content: string
  page_number: number | null
  section_title: string | null
  similarity: number
}

export interface SearchRequest {
  query: string
  book_slugs?: string[]
  top_k?: number
  similarity_threshold?: number
}

export interface SearchResponse {
  results: SearchResult[]
  query_embedding_tokens: number
  latency_ms: {
    embedding: number
    retrieval: number
    total: number
  }
}

export interface ChatRequest {
  query: string
  book_slugs?: string[]
  top_k?: number
}

export interface ChatResponse {
  answer: string
  citations: Citation[]
  context_chunks_used: number
  latency_ms: {
    embedding: number
    retrieval: number
    llm: number
    total: number
  }
}

export interface Citation {
  book_title: string
  book_slug: string
  page_number: number | null
  similarity: number
}

// ─── Ingestion Types ───────────────────────────────────────────────────────────

export interface RawPage {
  pageNumber: number
  text: string
}

export interface TextChunk {
  content: string
  chunkIndex: number
  pageNumber: number
  sectionTitle: string | null
  tokenCount: number
  chunkHash: string
}

export interface BookMeta {
  slug: string
  title: string
  author: string
}
