import { getSupabaseAdmin } from './supabase'
import { embedQuery } from './openai'
import type { SearchResult } from '@/types'

const DEFAULT_TOP_K = 5
const DEFAULT_SIMILARITY_THRESHOLD = 0.75
const MAX_TOP_K = 10

export interface RetrievalOptions {
  query: string
  bookSlugs?: string[]
  topK?: number
  similarityThreshold?: number
}

export interface RetrievalResult {
  results: SearchResult[]
  embeddingTokens: number
  latency: {
    embedding: number
    retrieval: number
  }
}

export async function retrieve(options: RetrievalOptions): Promise<RetrievalResult> {
  const { query, bookSlugs, topK = DEFAULT_TOP_K, similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD } = options
  const safeTopK = Math.min(topK, MAX_TOP_K)

  // 1. Embed the query
  const embedStart = Date.now()
  const { embedding, tokens } = await embedQuery(query)
  const embedLatency = Date.now() - embedStart

  const supabase = getSupabaseAdmin()

  // 2. Resolve slugs to UUIDs (if filter provided)
  let bookIds: string[] | null = null
  if (bookSlugs && bookSlugs.length > 0) {
    const { data: books, error } = await supabase
      .from('books')
      .select('id')
      .in('slug', bookSlugs)
      .eq('is_active', true)

    if (error) throw new Error(`Failed to resolve book slugs: ${error.message}`)
    bookIds = (books ?? []).map((b) => b.id)

    if (bookIds.length === 0) {
      return { results: [], embeddingTokens: tokens, latency: { embedding: embedLatency, retrieval: 0 } }
    }
  }

  // 3. Call the match_chunks RPC function
  const retrievalStart = Date.now()
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_count: safeTopK,
    book_ids: bookIds,
    similarity_threshold: similarityThreshold,
  })
  const retrievalLatency = Date.now() - retrievalStart

  if (error) throw new Error(`Vector search failed: ${error.message}`)

  const results: SearchResult[] = (data ?? []).map((row: any) => ({
    id: row.id,
    book_id: row.book_id,
    book_slug: row.book_slug,
    book_title: row.book_title,
    content: row.content,
    page_number: row.page_number,
    section_title: row.section_title,
    similarity: row.similarity,
  }))

  return {
    results,
    embeddingTokens: tokens,
    latency: { embedding: embedLatency, retrieval: retrievalLatency },
  }
}
