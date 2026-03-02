import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const slug = process.argv[2] ?? 'dowbor-books'
  const { data } = await sb.from('chunks')
    .select('page_number, content, books!inner(slug)')
    .eq('books.slug', slug)
    .order('page_number')
  data?.forEach((r: any) => {
    console.log(`\n=== Page ${r.page_number} ===`)
    console.log(r.content.replace(/\n/g, ' '))
  })
}
main().catch(console.error)
