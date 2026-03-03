import OpenAI from 'openai'

const openaiApiKey = process.env.OPENAI_API_KEY
if (!openaiApiKey) throw new Error('Missing OPENAI_API_KEY')

// Chat completions — OpenAI gpt-4o-mini
export const openai = new OpenAI({ apiKey: openaiApiKey })

export const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536
export const CHAT_MODEL = 'gpt-4o-mini'

// Embed a single query string. Returns the embedding vector and token count.
export async function embedQuery(text: string): Promise<{ embedding: number[]; tokens: number }> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.trim(),
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return {
    embedding: response.data[0].embedding,
    tokens: response.usage.total_tokens,
  }
}

// Embed a batch of strings. Returns embeddings in the same order as input.
// Caller is responsible for batching to ≤ 100 items.
export async function embedBatch(
  texts: string[]
): Promise<{ embeddings: number[][]; tokens: number }> {
  if (texts.length === 0) return { embeddings: [], tokens: 0 }

  const response = await embeddingsClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map((t) => t.trim()),
    dimensions: EMBEDDING_DIMENSIONS,
  })

  const embeddings = response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)

  return {
    embeddings,
    tokens: response.usage.total_tokens,
  }
}
