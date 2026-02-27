import { getSupabaseAdmin } from './supabase'
import { embedQuery } from './openai'
import type { SearchResult } from '@/types'

const DEFAULT_TOP_K = 5
const DEFAULT_SIMILARITY_THRESHOLD = 0.4
const MAX_TOP_K = 10

// Synthetic similarity score assigned to keyword-only matches.
// Lower than typical semantic matches so they rank after good vector hits.
const KEYWORD_MATCH_SIMILARITY = 0.45

// Portuguese stop words to skip when building keyword search terms
const PT_STOP_WORDS = new Set([
  'que', 'para', 'com', 'uma', 'uns', 'umas', 'por', 'nos', 'nas', 'dos',
  'das', 'aos', 'nao', 'não', 'como', 'mas', 'mais', 'seu', 'sua', 'seus',
  'suas', 'ele', 'ela', 'eles', 'elas', 'isso', 'este', 'esta', 'esse',
  'essa', 'isto', 'aqui', 'ali', 'quando', 'onde', 'porque', 'sobre',
  'entre', 'sendo', 'fazer', 'feito', 'dizer', 'disse', 'pode', 'tem',
  'ter', 'ser', 'foi', 'eram', 'está', 'estao', 'são', 'sem', 'muito',
  'ainda', 'pela', 'pelo', 'pelas', 'pelos', 'num', 'numa', 'procure',
  'busque', 'encontre', 'livro', 'livros', 'texto', 'autor', 'obra',
  'referencias', 'menção', 'menciona', 'fala', 'diz', 'escreve',
])

/**
 * Extract meaningful search terms from a query, filtering stop words.
 * Terms of 4+ chars that aren't stop words are used for keyword search.
 */
function extractKeywordTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .split(/\s+/)
        .map(w => w.toLowerCase().replace(/[^\w\u00C0-\u024F]/g, ''))
        .filter(w => w.length >= 4 && !PT_STOP_WORDS.has(w))
    ),
  ].slice(0, 6) // cap at 6 terms to keep the OR query manageable
}

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

  // 3. Run vector search and keyword search in parallel
  const retrievalStart = Date.now()

  const keywordTerms = extractKeywordTerms(query)
  const orFilter = keywordTerms.map(t => `content.ilike.%${t}%`).join(',')

  const [vectorResponse, keywordResponse] = await Promise.all([
    // 3a. Semantic vector search
    supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_count: safeTopK,
      book_ids: bookIds,
      similarity_threshold: similarityThreshold,
    }),

    // 3b. Keyword search — finds exact term matches that semantic search may miss
    keywordTerms.length > 0
      ? (() => {
          let q = supabase
            .from('chunks')
            .select('id, book_id, content, page_number, section_title, books!inner(slug, title)')
            .or(orFilter)
            .limit(safeTopK)
          if (bookIds) q = q.in('book_id', bookIds)
          return q
        })()
      : Promise.resolve({ data: [], error: null }),
  ])

  const retrievalLatency = Date.now() - retrievalStart

  if (vectorResponse.error) throw new Error(`Vector search failed: ${vectorResponse.error.message}`)

  // 4. Map vector results
  const vectorResults: SearchResult[] = (vectorResponse.data ?? []).map((row: any) => ({
    id: row.id,
    book_id: row.book_id,
    book_slug: row.book_slug,
    book_title: row.book_title,
    content: row.content,
    page_number: row.page_number,
    section_title: row.section_title,
    similarity: row.similarity,
  }))

  // 5. Map keyword results, skipping chunks already in vector results
  const vectorIds = new Set(vectorResults.map(r => r.id))
  const keywordResults: SearchResult[] = (keywordResponse.data ?? [])
    .filter((row: any) => !vectorIds.has(row.id))
    .map((row: any) => ({
      id: row.id,
      book_id: row.book_id,
      book_slug: (row.books as any).slug,
      book_title: (row.books as any).title,
      content: row.content,
      page_number: row.page_number,
      section_title: row.section_title,
      similarity: KEYWORD_MATCH_SIMILARITY,
    }))

  // 6. Merge: semantic results first (ranked by similarity), keyword results appended
  const results = [...vectorResults, ...keywordResults]

  return {
    results,
    embeddingTokens: tokens,
    latency: { embedding: embedLatency, retrieval: retrievalLatency },
  }
}
