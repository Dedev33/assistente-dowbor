import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

// Called by Vercel Cron every 3 days to keep the Supabase project active.
// Vercel automatically sends Authorization: Bearer <CRON_SECRET> — reject anything else.
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase.from('books').select('id').limit(1)
    if (error) throw error
    return NextResponse.json({ ok: true, ts: new Date().toISOString() })
  } catch (err: any) {
    console.error('[cron/keep-alive]', err)
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}
