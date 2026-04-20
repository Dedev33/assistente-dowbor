import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { rateLimit, getClientIp } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!rateLimit(ip, 20, 60_000)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
  }

  let log_id: string
  let feedback: string

  try {
    const body = await req.json()
    if (!body.log_id || !['up', 'down'].includes(body.feedback)) {
      return new Response(JSON.stringify({ error: 'Invalid body' }), { status: 400 })
    }
    log_id = body.log_id
    feedback = body.feedback
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
  }

  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('search_logs')
    .update({ feedback })
    .eq('id', log_id)

  if (error) {
    console.error('[/api/feedback]', error)
    return new Response(JSON.stringify({ error: 'Failed to save feedback' }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}
