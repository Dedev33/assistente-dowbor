#!/usr/bin/env npx ts-node
/**
 * Web scraper — dowbor.org → RAG index
 *
 * Crawls all pages listed in the site's XML sitemap, extracts text with cheerio,
 * and indexes the content using the same chunking + embedding pipeline as ingest.ts.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json -r tsconfig-paths/register scripts/scrape.ts
 *
 * Idempotent: re-running skips already-indexed chunks (same chunk_hash dedup).
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import * as cheerio from 'cheerio'
import { chunkPages, BATCH_SIZE } from '../src/lib/chunker'
import type { RawPage } from '../src/types'

// ─── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

const BOOK_SLUG = 'dowbor-org'
const BOOK_TITLE = 'dowbor.org — Artigos e Publicações'
const BOOK_AUTHOR = 'Ladislau Dowbor'

// Concurrency: fetch N pages simultaneously
const FETCH_CONCURRENCY = 5
// Polite delay between concurrency batches (ms)
const FETCH_DELAY_MS = 300

const WP_API = 'https://dowbor.org/wp-json/wp/v2'

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
  console.error('❌ Missing required environment variables. Check your .env.local file.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// ─── Retry with Exponential Backoff ──────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes('429')
      if (!isRateLimit || attempt === maxRetries) throw err
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
      console.warn(`  ⚠ Rate limited. Retrying in ${Math.round(delay / 1000)}s...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('Max retries exceeded')
}

// ─── Sitemap Parsing ──────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dowbor-rag-indexer/1.0 (research tool)' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

/** Collect all post/page URLs via WordPress REST API (handles pagination automatically). */
async function getAllUrls(): Promise<string[]> {
  console.log('📡 Discovering URLs via WordPress REST API...')
  const urls: string[] = []

  for (const endpoint of ['posts', 'pages']) {
    let page = 1
    let totalPages = 1

    while (page <= totalPages) {
      const res = await fetch(
        `${WP_API}/${endpoint}?per_page=100&page=${page}&_fields=link`,
        { headers: { 'User-Agent': 'dowbor-rag-indexer/1.0 (research tool)' } }
      )
      if (!res.ok) break

      // WordPress returns total page count in response headers
      totalPages = parseInt(res.headers.get('X-WP-TotalPages') ?? '1', 10)
      const total = res.headers.get('X-WP-Total') ?? '?'

      const items: Array<{ link: string }> = await res.json()
      items.forEach(item => { if (item.link) urls.push(item.link) })

      console.log(`   ${endpoint} page ${page}/${totalPages} (${total} total)`)
      page++
    }
  }

  console.log(`   ✓ ${urls.length} URLs discovered`)
  return urls
}

// ─── Page Content Extraction ──────────────────────────────────────────────────

interface ScrapedPage {
  url: string
  title: string
  text: string
}

function extractPageContent(html: string, url: string): ScrapedPage | null {
  const $ = cheerio.load(html)

  // Remove noise elements
  $('nav, header, footer, aside, script, style, noscript').remove()
  $('.wp-block-buttons, .entry-meta, .post-navigation, .comments-area').remove()
  $('.site-footer, .site-header, .main-navigation, .widget-area').remove()
  $('[class*="sidebar"], [id*="sidebar"], [class*="menu"], [id*="menu"]').remove()
  $('.sharedaddy, .jp-relatedposts, .wpcnt').remove()

  // Extract title
  const title =
    $('h1.entry-title').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().replace(' – Dowbor.org', '').replace(' | Dowbor.org', '').trim()

  // Extract body — try WordPress content selectors in order
  let bodyEl =
    $('.entry-content').first() ||
    $('article').first() ||
    $('.post-content').first() ||
    $('main').first()

  // Convert to plain text: collapse whitespace, preserve paragraph breaks
  let text = bodyEl
    .find('p, h2, h3, h4, li, blockquote')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(t => t.length > 0)
    .join('\n\n')

  // Fallback: grab all body text
  if (text.trim().length < 100) {
    text = $('body').text().replace(/\s{3,}/g, '\n\n').trim()
  }

  if (!title && text.length < 50) return null

  return { url, title: title || url, text }
}

// ─── Fetch Pages with Concurrency ────────────────────────────────────────────

async function fetchPages(urls: string[]): Promise<ScrapedPage[]> {
  const pages: ScrapedPage[] = []
  const errors: string[] = []

  console.log(`\n🌐 Fetching ${urls.length} pages (concurrency=${FETCH_CONCURRENCY})...`)

  for (let i = 0; i < urls.length; i += FETCH_CONCURRENCY) {
    const batch = urls.slice(i, i + FETCH_CONCURRENCY)

    const results = await Promise.allSettled(
      batch.map(async url => {
        const html = await fetchText(url)
        return extractPageContent(html, url)
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        pages.push(result.value)
      } else if (result.status === 'rejected') {
        errors.push(result.reason?.message ?? 'unknown error')
      }
    }

    const done = Math.min(i + FETCH_CONCURRENCY, urls.length)
    process.stdout.write(`\r   Fetched: ${done}/${urls.length} (${errors.length} errors)`)

    if (i + FETCH_CONCURRENCY < urls.length) {
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS))
    }
  }

  console.log(`\n   ✓ ${pages.length} pages extracted, ${errors.length} failed`)
  return pages
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🕷  dowbor.org scraper — RAG indexer\n')

  // 1. Discover URLs via WordPress REST API
  const urls = await getAllUrls()
  console.log(`\n   Total URLs to scrape: ${urls.length}`)

  // 2. Fetch and extract content from all pages
  const scraped = await fetchPages(urls)

  // 3. Convert to RawPage[] (title prepended to text for better context)
  const pages: RawPage[] = scraped.map((p, i) => ({
    pageNumber: i + 1,
    text: p.title ? `${p.title}\n\n${p.text}` : p.text,
  }))
  console.log(`\n📄 Converted to ${pages.length} RawPages`)

  // 4. Chunk
  console.log('   Chunking...')
  const chunks = chunkPages(pages)
  console.log(`   Generated ${chunks.length} chunks`)

  // 5. Compute a hash for this scrape run (date-based for re-indexability)
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const scrapeHash = `web-${today}`

  // 6. Check if this exact run already completed
  const { data: existingBook } = await supabase
    .from('books')
    .select('id, total_chunks')
    .eq('slug', BOOK_SLUG)
    .eq('pdf_hash', scrapeHash)
    .eq('is_active', true)
    .single()

  let bookId: string
  if (existingBook) {
    console.log(`\n   Book already indexed for today (id: ${existingBook.id}). Re-running will skip duplicates.`)
    bookId = existingBook.id
  } else {
    // Deactivate any previous version
    const { data: oldBook } = await supabase
      .from('books')
      .select('id')
      .eq('slug', BOOK_SLUG)
      .eq('is_active', true)
      .single()

    if (oldBook) {
      await supabase.from('books').update({ is_active: false }).eq('id', oldBook.id)
      console.log(`\n   Deactivated previous version (id: ${oldBook.id})`)
    }

    const { data: newBook, error } = await supabase
      .from('books')
      .insert({
        slug: BOOK_SLUG,
        title: BOOK_TITLE,
        author: BOOK_AUTHOR,
        pdf_hash: scrapeHash,
        total_pages: pages.length,
        total_chunks: chunks.length,
        is_active: false,
      })
      .select('id')
      .single()

    if (error || !newBook) {
      console.error('❌ Failed to insert book:', error)
      process.exit(1)
    }
    bookId = newBook.id
    console.log(`\n   Registered book (id: ${bookId})`)
  }

  // 7. Create ingestion run
  const { data: run, error: runError } = await supabase
    .from('ingestion_runs')
    .insert({
      book_id: bookId,
      status: 'running',
      pdf_hash: scrapeHash,
      chunks_processed: 0,
      chunks_skipped: 0,
      last_processed_chunk_index: -1,
    })
    .select('id')
    .single()

  if (runError || !run) {
    console.error('❌ Failed to create ingestion run:', runError)
    process.exit(1)
  }
  const runId = run.id

  // 8. Embed and insert chunks in batches
  let processed = 0
  let skipped = 0

  console.log(`\n   Embedding and inserting ${chunks.length} chunks...\n`)

  for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
    const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE)

    // Layer 1: skip already-indexed chunks by hash
    const hashes = batch.map(c => c.chunkHash)
    const { data: existing } = await supabase
      .from('chunks')
      .select('chunk_hash')
      .eq('book_id', bookId)
      .in('chunk_hash', hashes)

    const existingHashes = new Set((existing ?? []).map((r: any) => r.chunk_hash))
    const newChunks = batch.filter(c => !existingHashes.has(c.chunkHash))
    skipped += batch.length - newChunks.length

    if (newChunks.length > 0) {
      const texts = newChunks.map(c => c.content)
      const embeddingResponse = await withRetry(() =>
        openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts, dimensions: EMBEDDING_DIMENSIONS })
      )

      const embeddings = embeddingResponse.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((d: any) => d.embedding)

      const rows = newChunks.map((chunk, i) => ({
        book_id: bookId,
        chunk_index: batchStart + batch.indexOf(chunk),
        chunk_hash: chunk.chunkHash,
        content: chunk.content,
        embedding: JSON.stringify(embeddings[i]),
        page_number: chunk.pageNumber,
        section_title: chunk.sectionTitle,
        token_count: chunk.tokenCount,
      }))

      const { error: insertError } = await supabase
        .from('chunks')
        .upsert(rows, { onConflict: 'book_id,chunk_hash', ignoreDuplicates: true })

      if (insertError) {
        console.error(`\n❌ Insert failed at batch ${batchStart}:`, insertError)
        await supabase
          .from('ingestion_runs')
          .update({ status: 'failed', error_message: insertError.message, completed_at: new Date().toISOString() })
          .eq('id', runId)
        process.exit(1)
      }

      processed += newChunks.length
    }

    const done = batchStart + batch.length
    const pct = Math.round((done / chunks.length) * 100)
    process.stdout.write(`\r   Progress: ${done}/${chunks.length} (${pct}%) — inserted: ${processed}, skipped: ${skipped}`)

    await supabase
      .from('ingestion_runs')
      .update({ chunks_processed: processed, chunks_skipped: skipped, last_processed_chunk_index: done - 1 })
      .eq('id', runId)
  }

  console.log('\n')

  // 9. Finalize
  await supabase
    .from('ingestion_runs')
    .update({ status: 'completed', completed_at: new Date().toISOString(), chunks_processed: processed, chunks_skipped: skipped })
    .eq('id', runId)

  await supabase
    .from('books')
    .update({ is_active: true, total_chunks: chunks.length })
    .eq('id', bookId)

  console.log('✅ Scrape completo!')
  console.log(`   Fonte:      ${BOOK_TITLE}`)
  console.log(`   Páginas:    ${pages.length}`)
  console.log(`   Chunks:     ${chunks.length} total`)
  console.log(`   Inseridos:  ${processed}`)
  console.log(`   Skipped:    ${skipped} (duplicatas)`)
  console.log(`   Run ID:     ${runId}`)
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err)
  process.exit(1)
})
