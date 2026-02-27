import { NextRequest } from 'next/server'
import { retrieve } from '@/lib/retrieval'
import {
  assembleContext,
  buildSystemPrompt,
  buildUserPrompt,
  buildFallbackSystemPrompt,
  buildFallbackUserPrompt,
  buildSuggestionsMessages,
} from '@/lib/prompt'
import { openai, CHAT_MODEL } from '@/lib/openai'
import { logSearch } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase'
import type { ChatRequest } from '@/types'

const encoder = new TextEncoder()

function send(controller: ReadableStreamDefaultController, obj: object) {
  controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
}

/** Generate 3 follow-up questions and send them as a suggestions event. */
async function sendSuggestions(
  controller: ReadableStreamDefaultController,
  query: string,
  answer: string
) {
  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.7,
      max_tokens: 200,
      messages: buildSuggestionsMessages(query, answer),
    })
    const raw = completion.choices[0]?.message?.content ?? ''
    const questions = raw
      .split('\n')
      .map(l => l.trim().replace(/^[\s\-\d.):"*]+/, '').replace(/[*"]+$/, ''))
      .filter(l => {
        if (l.length < 15) return false          // too short — likely a fragment
        if (!l.endsWith('?')) return false        // must be a complete question
        if (!/^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ]/.test(l)) return false  // must start with capital letter
        return true
      })
      .slice(0, 3)
    if (questions.length > 0) {
      send(controller, { type: 'suggestions', questions })
    }
  } catch {
    // Suggestions are optional — silently skip on error
  }
}

export async function POST(req: NextRequest) {
  const total_start = Date.now()

  let body: ChatRequest
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 })
  }

  const { query, book_slugs, top_k, history = [] } = body

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: 'query is required and must be a non-empty string' }),
      { status: 400 }
    )
  }

  // Keep last 3 exchanges (6 messages) as conversation context
  const recentHistory = history.slice(-6)

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1. Retrieve relevant chunks
        const { results, embeddingTokens, latency: retrievalLatency } = await retrieve({
          query: query.trim(),
          bookSlugs: book_slugs,
          topK: top_k ?? 5,
        })

        // 2a. Fallback — no chunks found, or best match is too weak to be useful
        // Vector matches below 0.5 are tangentially related but don't answer the question;
        // keyword-only matches have a synthetic score of 0.45 and also fall below this bar.
        const bestSimilarity = results[0]?.similarity ?? 0
        if (results.length === 0 || bestSimilarity < 0.5) {
          const supabase = getSupabaseAdmin()
          const { data: books } = await supabase
            .from('books')
            .select('title')
            .eq('is_active', true)
            .order('title')
          const bookTitles = (books ?? []).map((b: { title: string }) => b.title)

          send(controller, { type: 'meta', citations: [], is_fallback: true, context_chunks_used: 0 })

          const llm_start = Date.now()
          let answerTokens = 0
          let promptTokens = 0

          const completion = await openai.chat.completions.create({
            model: CHAT_MODEL,
            temperature: 0.1,
            max_tokens: 512,
            stream: true,
            stream_options: { include_usage: true },
            messages: [
              { role: 'system', content: buildFallbackSystemPrompt(bookTitles) },
              ...recentHistory,
              { role: 'user', content: buildFallbackUserPrompt(query.trim()) },
            ],
          })

          for await (const chunk of completion) {
            const text = chunk.choices[0]?.delta?.content ?? ''
            if (text) send(controller, { type: 'chunk', text })
            if (chunk.usage) {
              answerTokens = chunk.usage.completion_tokens
              promptTokens = chunk.usage.prompt_tokens
            }
          }

          const llmLatency = Date.now() - llm_start
          const totalLatency = Date.now() - total_start

          send(controller, {
            type: 'done',
            latency_ms: {
              embedding: retrievalLatency.embedding,
              retrieval: retrievalLatency.retrieval,
              llm: llmLatency,
              total: totalLatency,
            },
            tokens: { embedding: embeddingTokens, llm_input: promptTokens, llm_output: answerTokens },
          })

          logSearch({
            query_text: query.trim(),
            book_ids_filter: book_slugs ?? null,
            results_count: 0,
            top_similarity: null,
            latency_embedding_ms: retrievalLatency.embedding,
            latency_retrieval_ms: retrievalLatency.retrieval,
            latency_llm_ms: llmLatency,
            latency_total_ms: totalLatency,
            llm_model: CHAT_MODEL,
            answer_tokens: answerTokens,
          })

          controller.close()
          return
        }

        // 2b. Normal RAG path
        const { contextText, usedChunks, citations } = assembleContext(results)

        send(controller, {
          type: 'meta',
          citations,
          is_fallback: false,
          context_chunks_used: usedChunks.length,
        })

        const llm_start = Date.now()
        let answerTokens = 0
        let promptTokens = 0
        let fullAnswer = ''

        const completion = await openai.chat.completions.create({
          model: CHAT_MODEL,
          temperature: 0.2,
          max_tokens: 1024,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            ...recentHistory,
            { role: 'user', content: buildUserPrompt(contextText, query.trim()) },
          ],
        })

        for await (const chunk of completion) {
          const text = chunk.choices[0]?.delta?.content ?? ''
          if (text) {
            fullAnswer += text
            send(controller, { type: 'chunk', text })
          }
          if (chunk.usage) {
            answerTokens = chunk.usage.completion_tokens
            promptTokens = chunk.usage.prompt_tokens
          }
        }

        const llmLatency = Date.now() - llm_start
        const totalLatency = Date.now() - total_start

        send(controller, {
          type: 'done',
          latency_ms: {
            embedding: retrievalLatency.embedding,
            retrieval: retrievalLatency.retrieval,
            llm: llmLatency,
            total: totalLatency,
          },
          tokens: { embedding: embeddingTokens, llm_input: promptTokens, llm_output: answerTokens },
        })

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

        // Generate follow-up suggestions after the main answer is done
        await sendSuggestions(controller, query.trim(), fullAnswer)

        controller.close()
      } catch (err: any) {
        console.error('[/api/chat]', err)
        send(controller, { type: 'error', message: err.message ?? 'Internal server error' })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}
