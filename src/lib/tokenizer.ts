import { get_encoding } from 'tiktoken'

// cl100k_base is the encoding used by text-embedding-3-small and gpt-4o
const enc = get_encoding('cl100k_base')

export function countTokens(text: string): number {
  return enc.encode(text).length
}

// Truncate text to a maximum number of tokens, preserving whole words.
export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = enc.encode(text)
  if (tokens.length <= maxTokens) return text
  const truncated = tokens.slice(0, maxTokens)
  return new TextDecoder().decode(enc.decode(truncated))
}
