import { NextRequest, NextResponse } from 'next/server'
import { retrieve } from '@/lib/retrieval'
import { logSearch } from '@/lib/logger'
import type { SearchRequest, SearchResponse } from '@/types'

export async function POST(req: NextRequest) {
  const total_start = Date.now()

  let body: SearchRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { query, book_slugs, top_k, similarity_threshold } = body

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return NextResponse.json({ error: 'query is required and must be a non-empty string' }, { status: 400 })
  }

  try {
    const { results, embeddingTokens, latency } = await retrieve({
      query: query.trim(),
      bookSlugs: book_slugs,
      topK: top_k,
      similarityThreshold: similarity_threshold,
    })

    const totalLatency = Date.now() - total_start

    // Fire-and-forget log
    logSearch({
      query_text: query.trim(),
      book_ids_filter: book_slugs ?? null,
      results_count: results.length,
      top_similarity: results[0]?.similarity ?? null,
      latency_embedding_ms: latency.embedding,
      latency_retrieval_ms: latency.retrieval,
      latency_total_ms: totalLatency,
    })

    const response: SearchResponse = {
      results,
      query_embedding_tokens: embeddingTokens,
      latency_ms: {
        embedding: latency.embedding,
        retrieval: latency.retrieval,
        total: totalLatency,
      },
    }

    return NextResponse.json(response)
  } catch (err: any) {
    console.error('[/api/search]', err)
    return NextResponse.json({ error: err.message ?? 'Internal server error' }, { status: 500 })
  }
}
