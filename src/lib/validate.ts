const SLUG_RE = /^[a-z0-9-]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ValidationError extends Error {
  status = 400
  constructor(message: string) {
    super(message)
  }
}

export function validateChatBody(body: unknown): {
  query: string
  book_slugs?: string[]
  top_k: number
  history: { role: 'user' | 'assistant'; content: string }[]
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  // query
  if (typeof b.query !== 'string' || b.query.trim().length === 0) {
    throw new ValidationError('query is required and must be a non-empty string')
  }
  if (b.query.length > 3000) {
    throw new ValidationError('query must be at most 3000 characters')
  }

  // book_slugs
  let book_slugs: string[] | undefined
  if (b.book_slugs !== undefined && b.book_slugs !== null) {
    if (!Array.isArray(b.book_slugs)) throw new ValidationError('book_slugs must be an array')
    if (b.book_slugs.length > 10) throw new ValidationError('book_slugs must have at most 10 items')
    for (const s of b.book_slugs) {
      if (typeof s !== 'string' || !SLUG_RE.test(s)) {
        throw new ValidationError(`Invalid book slug: "${s}"`)
      }
    }
    book_slugs = b.book_slugs as string[]
  }

  // top_k
  let top_k = 5
  if (b.top_k !== undefined) {
    if (typeof b.top_k !== 'number' || !Number.isInteger(b.top_k)) {
      throw new ValidationError('top_k must be an integer')
    }
    if (b.top_k < 1 || b.top_k > 10) throw new ValidationError('top_k must be between 1 and 10')
    top_k = b.top_k
  }

  // history
  let history: { role: 'user' | 'assistant'; content: string }[] = []
  if (b.history !== undefined) {
    if (!Array.isArray(b.history)) throw new ValidationError('history must be an array')
    if (b.history.length > 20) throw new ValidationError('history must have at most 20 items')
    for (const msg of b.history) {
      if (!msg || typeof msg !== 'object') throw new ValidationError('Each history item must be an object')
      const { role, content } = msg as Record<string, unknown>
      if (role !== 'user' && role !== 'assistant') {
        throw new ValidationError('history role must be "user" or "assistant"')
      }
      if (typeof content !== 'string' || content.length > 10000) {
        throw new ValidationError('history content must be a string of at most 10000 characters')
      }
    }
    history = b.history as { role: 'user' | 'assistant'; content: string }[]
  }

  return { query: b.query.trim(), book_slugs, top_k, history }
}

export function validateSearchBody(body: unknown): {
  query: string
  book_slugs?: string[]
  top_k?: number
  similarity_threshold?: number
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (typeof b.query !== 'string' || b.query.trim().length === 0) {
    throw new ValidationError('query is required and must be a non-empty string')
  }
  if (b.query.length > 3000) {
    throw new ValidationError('query must be at most 3000 characters')
  }

  let book_slugs: string[] | undefined
  if (b.book_slugs !== undefined && b.book_slugs !== null) {
    if (!Array.isArray(b.book_slugs)) throw new ValidationError('book_slugs must be an array')
    if (b.book_slugs.length > 10) throw new ValidationError('book_slugs must have at most 10 items')
    for (const s of b.book_slugs) {
      if (typeof s !== 'string' || !SLUG_RE.test(s)) {
        throw new ValidationError(`Invalid book slug: "${s}"`)
      }
    }
    book_slugs = b.book_slugs as string[]
  }

  let top_k: number | undefined
  if (b.top_k !== undefined) {
    if (typeof b.top_k !== 'number' || !Number.isInteger(b.top_k)) {
      throw new ValidationError('top_k must be an integer')
    }
    if (b.top_k < 1 || b.top_k > 10) throw new ValidationError('top_k must be between 1 and 10')
    top_k = b.top_k
  }

  let similarity_threshold: number | undefined
  if (b.similarity_threshold !== undefined) {
    if (typeof b.similarity_threshold !== 'number') {
      throw new ValidationError('similarity_threshold must be a number')
    }
    if (b.similarity_threshold < 0 || b.similarity_threshold > 1) {
      throw new ValidationError('similarity_threshold must be between 0 and 1')
    }
    similarity_threshold = b.similarity_threshold
  }

  return { query: b.query.trim(), book_slugs, top_k, similarity_threshold }
}

export { UUID_RE }
