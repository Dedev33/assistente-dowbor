/**
 * Simple in-memory sliding window rate limiter.
 * Works per serverless instance — good enough to stop casual abuse.
 * For stricter enforcement across all instances, use Upstash Redis.
 */

interface Window {
  timestamps: number[]
}

const store = new Map<string, Window>()

/**
 * Returns true if the request is allowed, false if rate limit exceeded.
 * @param key    Identifier (e.g. IP address)
 * @param limit  Max requests allowed in the window
 * @param windowMs  Window size in milliseconds
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const cutoff = now - windowMs

  let entry = store.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    store.set(key, entry)
  }

  // Drop timestamps outside the window
  entry.timestamps = entry.timestamps.filter(t => t > cutoff)

  if (entry.timestamps.length >= limit) return false

  entry.timestamps.push(now)
  return true
}

export function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}
