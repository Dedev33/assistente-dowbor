import { encode, decode } from 'gpt-tokenizer'

// cl100k_base encoding — compatible with text-embedding-3-small and gpt-4o
export function countTokens(text: string): number {
  return encode(text).length
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = encode(text)
  if (tokens.length <= maxTokens) return text
  return decode(tokens.slice(0, maxTokens))
}
