import { NextRequest, NextResponse } from 'next/server'
import { retrieve } from '@/lib/retrieval'
import { assembleContext, buildSystemPrompt, buildUserPrompt } from '@/lib/prompt'
import { openai, CHAT_MODEL } from '@/lib/openai'
import { logSearch } from '@/lib/logger'
import type { ChatRequest, ChatResponse } from '@/types'

export async function POST(req: NextRequest) {
  const total_start = Date.now()

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { query, book_slugs, top_k } = body

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return NextResponse.json({ error: 'query is required and must be a non-empty string' }, { status: 400 })
  }

  try {
    // 1. Retrieve relevant chunks
    const { results, embeddingTokens, latency: retrievalLatency } = await retrieve({
      query: query.trim(),
      bookSlugs: book_slugs,
      topK: top_k ?? 5,
    })

    if (results.length === 0) {
      return NextResponse.json({
        answer: 'Não encontrei informações relevantes nos livros disponíveis para responder a sua pergunta.',
        citations: [],
        context_chunks_used: 0,
        latency_ms: {
          embedding: retrievalLatency.embedding,
          retrieval: retrievalLatency.retrieval,
          llm: 0,
          total: Date.now() - total_start,
        },
      } satisfies ChatResponse)
    }

    // 2. Assemble context
    const { contextText, usedChunks, citations } = assembleContext(results)

    // 3. Build and send prompt
    const llm_start = Date.now()
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(contextText, query.trim()) },
      ],
    })
    const llmLatency = Date.now() - llm_start

    const answer = completion.choices[0]?.message?.content ?? 'Sem resposta.'
    const answerTokens = completion.usage?.completion_tokens ?? 0
    const totalLatency = Date.now() - total_start

    // Fire-and-forget log
    logSearch({
      query_text: query.trim(),
      book_ids_filter: book_slugs ?? null,
      results_count: usedChunks.length,
      top_similarity: results[0]?.similarity ?? null,
      latency_embedding_ms: retrievalLatency.embedding,
      latency_retrieval_ms: retrievalLatency.retrieval,
      latency_llm_ms: llmLatency,
      latency_total_ms: totalLatency,
      llm_model: CHAT_MODEL,
      answer_tokens: answerTokens,
    })

    const response: ChatResponse = {
      answer,
      citations,
      context_chunks_used: usedChunks.length,
      latency_ms: {
        embedding: retrievalLatency.embedding,
        retrieval: retrievalLatency.retrieval,
        llm: llmLatency,
        total: totalLatency,
      },
    }

    return NextResponse.json(response)
  } catch (err: any) {
    console.error('[/api/chat]', err)
    return NextResponse.json({ error: err.message ?? 'Internal server error' }, { status: 500 })
  }
}
