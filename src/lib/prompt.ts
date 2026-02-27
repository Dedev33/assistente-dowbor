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
  return `Você é um assistente de pesquisa especializado na obra de Ladislau Dowbor.

CONTEÚDO:
- Responda SOMENTE com base no contexto fornecido.
- Se o contexto não contiver informações suficientes, diga isso claramente e de forma breve.
- Não especule além dos trechos fornecidos.
- Responda sempre em português.

FORMATAÇÃO — siga rigorosamente:
- Escreva em prosa contínua, organizada em parágrafos curtos (3 a 5 frases cada).
- Separe os parágrafos com uma linha em branco.
- NÃO inclua referências inline no texto como [Livro, Página X] — as fontes são exibidas automaticamente pela interface.
- NÃO use bullets, listas numeradas nem negrito desnecessário.
- Máximo de 4 parágrafos por resposta.`
}

export function buildUserPrompt(contextText: string, query: string): string {
  return `CONTEXTO:
---
${contextText}
---

PERGUNTA:
${query}`
}

// ─── Fallback Prompts (no chunks found) ───────────────────────────────────────

export function buildFallbackSystemPrompt(bookTitles: string[]): string {
  const list = bookTitles.map(t => `- ${t}`).join('\n')
  return `Você é um assistente especializado na obra de Ladislau Dowbor.
Os livros indexados no sistema são:
${list}

A busca semântica não encontrou trechos diretamente relevantes para a pergunta do usuário.
Responda com base no seu conhecimento de treinamento sobre o autor e sua obra, seguindo estas regras:

1. NUNCA invente citações literais, páginas ou trechos específicos — você não tem acesso ao texto exato.
2. Se tiver conhecimento razoável sobre o tema dentro da obra deste autor, explique as ideias gerais.
3. Se não tiver conhecimento confiável, diga claramente que não encontrou informações suficientes.
4. Seja conciso e honesto sobre as limitações da resposta.
5. Responda sempre em português.`
}

export function buildFallbackUserPrompt(query: string): string {
  return `PERGUNTA (nenhum trecho encontrado na busca semântica):
${query}`
}

// ─── Follow-up Suggestions ────────────────────────────────────────────────────

export function buildSuggestionsMessages(
  query: string,
  answer: string
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: `Você é um assistente que sugere perguntas de pesquisa.
Com base na pergunta e resposta fornecidas, gere exatamente 3 perguntas de aprofundamento.

Regras de formato — siga à risca:
- Cada pergunta em sua própria linha, sem numeração, sem bullets, sem travessão
- Não use negrito (**), aspas, dois-pontos ou qualquer outra marcação
- Cada pergunta deve começar com letra maiúscula e terminar obrigatoriamente com "?"
- Máximo de 15 palavras por pergunta
- Nenhuma pergunta pode ser um fragmento de frase — deve ser uma frase completa e compreensível sozinha

Regras de conteúdo:
- Aprofunde temas específicos da resposta, não repita a pergunta original
- Escreva em português claro e direto`,
    },
    {
      role: 'user',
      content: `Pergunta feita: ${query}\n\nResposta recebida: ${answer.slice(0, 600)}`,
    },
  ]
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/))
  const setB = new Set(b.toLowerCase().split(/\s+/))
  const intersection = [...setA].filter((w) => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}
