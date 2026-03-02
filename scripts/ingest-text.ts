#!/usr/bin/env npx ts-node
/**
 * Plain-text ingestion script
 *
 * Like ingest.ts but for .txt files instead of PDFs. Splits on double-newlines
 * to create RawPage[], then runs the same chunking + embedding pipeline.
 *
 * Usage:
 *   npm run ingest-text -- --file data/dowbor-bio.txt --slug dowbor-bio --title "Ladislau Dowbor — Biografia" --author "Ladislau Dowbor"
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { chunkPages, BATCH_SIZE } from '../src/lib/chunker'
import type { RawPage } from '../src/types'

// ─── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
  console.error('❌ Missing required environment variables. Check your .env.local file.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs(): { file: string; slug: string; title: string; author: string } {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const idx = args.indexOf(flag)
    return idx !== -1 ? args[idx + 1] : undefined
  }
  const file = get('--file')
  const slug = get('--slug')
  const title = get('--title')
  const author = get('--author') ?? 'Unknown'

  if (!file || !slug || !title) {
    console.error('Usage: npm run ingest-text -- --file <path> --slug <slug> --title "<title>" [--author "<author>"]')
    process.exit(1)
  }
  return { file, slug, title, author }
}

// ─── Retry with Exponential Backoff ──────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes('429')
      if (!isRateLimit || attempt === maxRetries) throw err
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
      console.warn(`  ⚠ Rate limited. Retrying in ${Math.round(delay / 1000)}s... (attempt ${attempt + 1}/${maxRetries})`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('Max retries exceeded')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { file, slug, title, author } = parseArgs()

  console.log(`\n📄 Starting text ingestion: "${title}"`)

  // 1. Read file and compute hash
  const filePath = path.resolve(file)
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`)
    process.exit(1)
  }
  const rawText = fs.readFileSync(filePath, 'utf-8')
  const fileHash = createHash('sha256').update(rawText).digest('hex').slice(0, 16)
  console.log(`   File hash: ${fileHash}`)

  // 2. Split into sections (double newlines = section boundaries → RawPage)
  const sections = rawText
    .split(/\n\n\n+/)          // triple+ newlines separate major sections
    .map(s => s.trim())
    .filter(s => s.length > 10)

  const pages: RawPage[] = sections.map((text, i) => ({ pageNumber: i + 1, text }))
  console.log(`   Parsed ${pages.length} sections`)

  // 3. Chunk
  console.log('   Chunking...')
  const chunks = chunkPages(pages)
  console.log(`   Generated ${chunks.length} chunks`)

  // 4. Check if already indexed
  const { data: existingBook } = await supabase
    .from('books')
    .select('id, total_chunks')
    .eq('slug', slug)
    .eq('pdf_hash', fileHash)
    .eq('is_active', true)
    .single()

  let bookId: string
  if (existingBook) {
    console.log(`\n   Book already indexed (id: ${existingBook.id}). Re-running will skip duplicates.`)
    bookId = existingBook.id
  } else {
    // Deactivate any previous version
    const { data: oldBook } = await supabase
      .from('books')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .single()

    if (oldBook) {
      await supabase.from('books').update({ is_active: false }).eq('id', oldBook.id)
      console.log(`\n   Deactivated previous version (id: ${oldBook.id})`)
    }

    const { data: newBook, error } = await supabase
      .from('books')
      .insert({
        slug,
        title,
        author,
        pdf_hash: fileHash,
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

  // 5. Create ingestion run
  const { data: run, error: runError } = await supabase
    .from('ingestion_runs')
    .insert({
      book_id: bookId,
      status: 'running',
      pdf_hash: fileHash,
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

  // 6. Embed and insert chunks in batches
  let processed = 0
  let skipped = 0

  console.log(`\n   Embedding and inserting ${chunks.length} chunks...\n`)

  for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
    const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE)

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

  // 7. Finalize
  await supabase
    .from('ingestion_runs')
    .update({ status: 'completed', completed_at: new Date().toISOString(), chunks_processed: processed, chunks_skipped: skipped })
    .eq('id', runId)

  await supabase
    .from('books')
    .update({ is_active: true, total_chunks: chunks.length })
    .eq('id', bookId)

  console.log('✅ Ingestão completa!')
  console.log(`   Documento:  ${title}`)
  console.log(`   Seções:     ${pages.length}`)
  console.log(`   Chunks:     ${chunks.length} total`)
  console.log(`   Inseridos:  ${processed}`)
  console.log(`   Skipped:    ${skipped} (duplicatas)`)
  console.log(`   Run ID:     ${runId}`)
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err)
  process.exit(1)
})
