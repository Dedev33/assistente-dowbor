import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from('books')
      .select('id, slug, title, author, total_pages, total_chunks, indexed_at, is_active')
      .order('title')

    if (error) throw error

    return NextResponse.json({ books: data ?? [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
