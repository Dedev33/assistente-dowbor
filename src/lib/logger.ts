import { getSupabaseAdmin } from './supabase'

interface SearchLogEntry {
  query_text: string
  book_ids_filter: string[] | null
  results_count: number
  top_similarity: number | null
  latency_embedding_ms: number
  latency_retrieval_ms: number
  latency_llm_ms?: number
  latency_total_ms: number
  llm_model?: string
  answer_tokens?: number
}

export async function logSearch(entry: SearchLogEntry): Promise<void> {
  try {
    const supabase = getSupabaseAdmin()
    await supabase.from('search_logs').insert(entry)
  } catch (err) {
    // Logging must never crash the request
    console.error('[logger] Failed to write search log:', err)
  }
}
