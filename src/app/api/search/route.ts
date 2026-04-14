import { NextRequest, NextResponse } from 'next/server'
import { retrieve } from '@/lib/retrieval'
import { logSearch } from '@/lib/logger'
import { validateSearchBody, ValidationError } from '@/lib/validate'
import { rateLimit, getClientIp } from '@/lib/ratelimit'
import type { SearchResponse } from '@/types'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!rateLimit(ip, 20, 60_000)) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait before searching again.' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

  const total_start = Date.now()

  let query: string
  let book_slugs: string[] | undefined
  let top_k: number | undefined
  let similarity_threshold: number | undefined

  try {
    const raw = await req.json()
    const validated = validateSearchBody(raw)
    query = validated.query
    book_slugs = validated.book_slugs
    top_k = validated.top_k
    similarity_threshold = validated.similarity_threshold
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const { results, embeddingTokens, latency } = await retrieve({
      query,
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
    const message = process.env.NODE_ENV === 'development'
      ? (err.message ?? 'Internal server error')
      : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
