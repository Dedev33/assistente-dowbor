import { countTokens } from './tokenizer'
import type { SearchResult, Citation } from '@/types'

const MAX_CONTEXT_TOKENS = 3000

// ─── Context Assembly ──────────────────────────────────────────────────────────

export function assembleContext(results: SearchResult[]): {
  contextText: string
  usedChunks: SearchResult[]
  citations: Citation[]
} {
  // 1. Sort by book + page for coherent reading order
  const sorted = [...results].sort((a, b) => {
    if (a.book_slug !== b.book_slug) return a.book_slug.localeCompare(b.book_slug)
    return (a.page_number ?? 0) - (b.page_number ?? 0)
  })

  // 2. Deduplicate chunks with > 80% token overlap (keep higher similarity)
  const deduplicated: SearchResult[] = []
  for (const chunk of sorted) {
    const isDuplicate = deduplicated.some((existing) => {
      const overlapScore = tokenOverlap(existing.content, chunk.content)
      return overlapScore > 0.8
    })
    if (!isDuplicate) deduplicated.push(chunk)
  }

  // 3. Enforce context token budget — drop lowest-similarity chunks if over limit
  let usedChunks: SearchResult[] = []
  let totalTokens = 0

  for (const chunk of deduplicated) {
    const chunkTokens = countTokens(chunk.content)
    if (totalTokens + chunkTokens > MAX_CONTEXT_TOKENS) {
      // Try removing the lowest-similarity chunk already added
      if (usedChunks.length > 0) {
        const lowestIdx = usedChunks.reduce(
          (minIdx, c, idx) => (c.similarity < usedChunks[minIdx].similarity ? idx : minIdx),
          0
        )
        if (usedChunks[lowestIdx].similarity < chunk.similarity) {
          totalTokens -= countTokens(usedChunks[lowestIdx].content)
          usedChunks.splice(lowestIdx, 1)
        } else {
          continue // skip this chunk
        }
      } else {
        continue
      }
    }
    usedChunks.push(chunk)
    totalTokens += chunkTokens
  }

  // 4. Build context string
  const contextBlocks = usedChunks.map(
    (chunk) =>
      `[Source: ${chunk.book_title}, Page ${chunk.page_number ?? 'N/A'}]\n${chunk.content}`
  )
  const contextText = contextBlocks.join('\n\n---\n\n')

  // 5. Build citations (unique pages per book)
  const citationMap = new Map<string, Citation>()
  for (const chunk of usedChunks) {
    const key = `${chunk.book_slug}::${chunk.page_number}`
    if (!citationMap.has(key)) {
      citationMap.set(key, {
        book_title: chunk.book_title,
        book_slug: chunk.book_slug,
        page_number: chunk.page_number,
        similarity: chunk.similarity,
      })
    }
  }

  return { contextText, usedChunks, citations: Array.from(citationMap.values()) }
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return `Você é um assistente de pesquisa especializado, com acesso a livros específicos de Ladislau Dowbor.
Responda perguntas SOMENTE com base no contexto fornecido.
Se o contexto não contiver informações suficientes para responder, diga isso claramente.
Sempre cite suas fontes usando o formato [Título do Livro, Página X].
Não especule além dos trechos fornecidos.
Responda sempre em português.`
}

export function buildUserPrompt(contextText: string, query: string): string {
  return `CONTEXTO:
---
${contextText}
---

PERGUNTA:
${query}`
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/))
  const setB = new Set(b.toLowerCase().split(/\s+/))
  const intersection = [...setA].filter((w) => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}
