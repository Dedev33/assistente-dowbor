import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

async function main() {
  const query = process.argv[2] ?? 'qual o livro mais antigo de dowbor?'
  console.log(`\nQuery: "${query}"\n`)

  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: query, dimensions: 1536 })
  const embedding = res.data[0].embedding

  // Test 1: same params as production (threshold 0.4, count 5)
  const { data: prod } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_count: 5,
    book_ids: null,
    similarity_threshold: 0.4,
  })
  console.log('=== Production params (threshold=0.4, count=5) ===')
  if (!prod?.length) console.log('  (no results above threshold)')
  prod?.forEach((r: any, i: number) => console.log(`  #${i+1} [${r.book_slug}] sim=${r.similarity.toFixed(4)}`))

  // Test 2: threshold 0.0 to see everything
  const { data } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_count: 15,
    book_ids: null,
    similarity_threshold: 0.0,
  })

  console.log('\nTop 15 results (threshold=0):\n')
  data?.forEach((row: any, i: number) => {
    console.log(`#${i+1} [${row.book_slug}] sim=${row.similarity.toFixed(4)} p.${row.page_number}`)
    console.log(`     ${row.content.slice(0, 120).replace(/\n/g,' ')}\n`)
  })
}

main().catch(console.error)
