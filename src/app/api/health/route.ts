import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const start = Date.now()

  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase.from('books').select('id').limit(1)

    if (error) {
      return NextResponse.json(
        { status: 'error', message: error.message, latency_ms: Date.now() - start },
        { status: 503 }
      )
    }

    return NextResponse.json({
      status: 'ok',
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
    })
  } catch (err: any) {
    return NextResponse.json(
      { status: 'error', message: err.message, latency_ms: Date.now() - start },
      { status: 503 }
    )
  }
}
