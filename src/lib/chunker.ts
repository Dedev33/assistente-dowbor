import { createHash } from 'crypto'
import { countTokens } from './tokenizer'
import type { RawPage, TextChunk } from '@/types'

const CHUNK_SIZE_TOKENS = 512
const OVERLAP_TOKENS = 100
const MIN_CHUNK_TOKENS = 50
const BATCH_SIZE = 100 // max items per OpenAI embedding batch

// ─── Text Cleaning ─────────────────────────────────────────────────────────────

export function cleanPageText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')           // normalize line endings
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')       // collapse excessive blank lines
    .replace(/[ \t]{2,}/g, ' ')       // collapse multiple spaces/tabs
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip control chars
    .trim()
}

// ─── Heading Detection ─────────────────────────────────────────────────────────

function detectSectionTitle(paragraph: string): string | null {
  const lines = paragraph.split('\n')
  const firstLine = lines[0].trim()
  // Heuristic: short first line (< 80 chars), ends without period → likely a heading
  if (firstLine.length > 0 && firstLine.length < 80 && !firstLine.endsWith('.')) {
    return firstLine
  }
  return null
}

// ─── Core Chunker ─────────────────────────────────────────────────────────────

export function chunkPages(pages: RawPage[]): TextChunk[] {
  // 1. Join all pages into paragraphs, tracking page numbers
  const paragraphsWithMeta: Array<{ text: string; pageNumber: number }> = []

  for (const page of pages) {
    const cleaned = cleanPageText(page.text)
    if (!cleaned) continue

    const paragraphs = cleaned.split(/\n\n+/)
    for (const para of paragraphs) {
      const trimmed = para.trim()
      if (!trimmed) continue
      paragraphsWithMeta.push({ text: trimmed, pageNumber: page.pageNumber })
    }
  }

  // 2. Merge tiny paragraphs and split oversized ones
  const rawChunks: Array<{ text: string; pageNumber: number }> = []
  let buffer = ''
  let bufferPage = 1

  for (const { text, pageNumber } of paragraphsWithMeta) {
    const tokens = countTokens(text)

    if (tokens > CHUNK_SIZE_TOKENS) {
      // Flush buffer first
      if (buffer) {
        rawChunks.push({ text: buffer.trim(), pageNumber: bufferPage })
        buffer = ''
      }
      // Split oversized paragraph at sentence boundaries
      const sentences = text.match(/[^.!?]+[.!?]+["']?|\s*\n/g) || [text]
      let sentBuffer = ''
      for (const sentence of sentences) {
        const combined = sentBuffer ? sentBuffer + ' ' + sentence : sentence
        if (countTokens(combined) > CHUNK_SIZE_TOKENS) {
          if (sentBuffer) rawChunks.push({ text: sentBuffer.trim(), pageNumber })
          sentBuffer = sentence
        } else {
          sentBuffer = combined
        }
      }
      if (sentBuffer.trim()) rawChunks.push({ text: sentBuffer.trim(), pageNumber })
    } else if (countTokens(buffer + '\n\n' + text) > CHUNK_SIZE_TOKENS) {
      // Adding this paragraph would exceed chunk size — flush buffer
      if (buffer) rawChunks.push({ text: buffer.trim(), pageNumber: bufferPage })
      buffer = text
      bufferPage = pageNumber
    } else {
      // Accumulate into buffer
      buffer = buffer ? buffer + '\n\n' + text : text
      if (!buffer) bufferPage = pageNumber
    }
  }
  if (buffer.trim()) rawChunks.push({ text: buffer.trim(), pageNumber: bufferPage })

  // 3. Filter out chunks below minimum token threshold
  const validChunks = rawChunks.filter(
    ({ text }) => countTokens(text) >= MIN_CHUNK_TOKENS
  )

  // 4. Apply overlap: prepend last OVERLAP_TOKENS of previous chunk to current
  const chunks: TextChunk[] = []
  let previousTail = ''

  for (let i = 0; i < validChunks.length; i++) {
    const { text, pageNumber } = validChunks[i]
    const content = previousTail ? previousTail + '\n\n' + text : text

    // Store tail of this chunk for next iteration
    const words = text.split(/\s+/)
    let tailTokens = 0
    let tailWords: string[] = []
    for (let j = words.length - 1; j >= 0; j--) {
      const candidate = words[j] + (tailWords.length ? ' ' + tailWords.join(' ') : '')
      if (countTokens(candidate) > OVERLAP_TOKENS) break
      tailWords.unshift(words[j])
      tailTokens = countTokens(tailWords.join(' '))
    }
    previousTail = tailWords.join(' ')

    const chunkHash = createHash('sha256').update(content).digest('hex')
    const tokenCount = countTokens(content)
    const sectionTitle = i === 0 || chunks.length === 0
      ? detectSectionTitle(text)
      : detectSectionTitle(text) ?? chunks[chunks.length - 1].sectionTitle

    chunks.push({
      content,
      chunkIndex: i,
      pageNumber,
      sectionTitle: sectionTitle ?? null,
      tokenCount,
      chunkHash,
    })
  }

  return chunks
}

export { BATCH_SIZE }
