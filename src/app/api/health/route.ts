import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseClient } from '@/lib/supabase'
import { rateLimit, getClientIp } from '@/lib/ratelimit'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!rateLimit(ip, 30, 60_000)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }
  const start = Date.now()

  try {
    const supabase = getSupabaseClient()
    const { error } = await supabase.from('books').select('id').limit(1)

    if (error) {
      console.error('[/api/health]', error)
      return NextResponse.json(
        { status: 'error', latency_ms: Date.now() - start },
        { status: 503 }
      )
    }

    return NextResponse.json({
      status: 'ok',
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
    })
  } catch (err: any) {
    console.error('[/api/health]', err)
    return NextResponse.json(
      { status: 'error', latency_ms: Date.now() - start },
      { status: 503 }
    )
  }
}
