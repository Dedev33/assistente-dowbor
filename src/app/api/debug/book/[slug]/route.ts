import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  try {
    const supabase = getSupabaseAdmin()

    const { data: book, error: bookError } = await supabase
      .from('books')
      .select('*')
      .eq('slug', slug)
      .single()

    if (bookError) throw bookError
    if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 })

    const { data: runs, error: runsError } = await supabase
      .from('ingestion_runs')
      .select('id, started_at, completed_at, status, chunks_processed, chunks_skipped, error_message, pdf_hash')
      .eq('book_id', book.id)
      .order('started_at', { ascending: false })
      .limit(10)

    if (runsError) throw runsError

    const { count, error: countError } = await supabase
      .from('chunks')
      .select('id', { count: 'exact', head: true })
      .eq('book_id', book.id)

    if (countError) throw countError

    return NextResponse.json({
      book,
      chunk_count: count ?? 0,
      ingestion_runs: runs ?? [],
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
