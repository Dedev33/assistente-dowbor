#!/usr/bin/env npx ts-node --esm
/**
 * Book ingestion script — Phase 1
 *
 * Usage:
 *   npx ts-node -e scripts/ingest.ts --file books/mybook.pdf --slug my-book --title "My Book" --author "Author Name"
 *
 * The script is idempotent: running it twice on the same PDF produces no new inserts.
 * If interrupted, restart it — it resumes from the last processed chunk index.
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
// @ts-ignore — pdf-parse lacks complete type defs
import pdfParse from 'pdf-parse'
import { chunkPages, BATCH_SIZE } from '../src/lib/chunker'
import { cleanPageText } from '../src/lib/chunker'
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
    console.error('Usage: npx ts-node scripts/ingest.ts --file <path> --slug <slug> --title "<title>" [--author "<author>"]')
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
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error('Max retries exceeded')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { file, slug, title, author } = parseArgs()

  // 1. Read and hash PDF
  console.log(`\n📚 Starting ingestion: "${title}"`)
  const pdfBuffer = fs.readFileSync(path.resolve(file))
  const pdfHash = createHash('sha256').update(pdfBuffer).digest('hex').slice(0, 16)
  console.log(`   PDF hash: ${pdfHash}`)

  // 2. Check if this exact PDF version is already fully indexed
  const { data: existingBook } = await supabase
    .from('books')
    .select('id, pdf_hash, total_chunks')
    .eq('slug', slug)
    .eq('pdf_hash', pdfHash)
    .eq('is_active', true)
    .single()

  // 3. Parse PDF — per-page via pagerender callback
  console.log('   Parsing PDF...')
  const perPageTexts: string[] = []
  await pdfParse(pdfBuffer, {
    pagerender: (pageData: any) =>
      pageData.getTextContent().then((content: any) => {
        const text = content.items.map((item: any) => item.str).join(' ')
        perPageTexts.push(text)
        return text
      }),
  })
  const totalPages = perPageTexts.length

  const pages: RawPage[] = []
  for (let i = 0; i < perPageTexts.length; i++) {
    const cleaned = cleanPageText(perPageTexts[i])
    if (cleaned.length > 10) {
      pages.push({ pageNumber: i + 1, text: cleaned })
    }
  }
  console.log(`   Extracted ${pages.length} non-empty pages out of ${totalPages}`)

  // 4. Chunk
  console.log('   Chunking...')
  const chunks = chunkPages(pages)
  console.log(`   Generated ${chunks.length} chunks`)

  // 5. Upsert book record
  let bookId: string
  if (existingBook) {
    bookId = existingBook.id
    console.log(`   Book already registered (id: ${bookId})`)
  } else {
    // Check if slug exists with a different hash (new version)
    const { data: oldBook } = await supabase
      .from('books')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .single()

    if (oldBook) {
      // Deactivate old version
      await supabase.from('books').update({ is_active: false }).eq('id', oldBook.id)
      console.log(`   Deactivated old version (id: ${oldBook.id})`)
    }

    const { data: newBook, error } = await supabase
      .from('books')
      .insert({ slug, title, author, pdf_hash: pdfHash, total_pages: totalPages, total_chunks: chunks.length, is_active: false })
      .select('id')
      .single()

    if (error || !newBook) {
      console.error('❌ Failed to insert book:', error)
      process.exit(1)
    }
    bookId = newBook.id
    console.log(`   Registered new book (id: ${bookId})`)
  }

  // 6. Start or resume ingestion run
  let runId: string
  let resumeFrom = 0

  const { data: existingRun } = await supabase
    .from('ingestion_runs')
    .select('id, last_processed_chunk_index, chunks_processed, chunks_skipped')
    .eq('book_id', bookId)
    .eq('pdf_hash', pdfHash)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .single()

  if (existingRun) {
    runId = existingRun.id
    resumeFrom = (existingRun.last_processed_chunk_index ?? 0) + 1
    console.log(`   Resuming from chunk ${resumeFrom}`)
  } else {
    const { data: newRun, error } = await supabase
      .from('ingestion_runs')
      .insert({ book_id: bookId, status: 'running', pdf_hash: pdfHash, chunks_processed: 0, chunks_skipped: 0, last_processed_chunk_index: -1 })
      .select('id')
      .single()

    if (error || !newRun) {
      console.error('❌ Failed to create ingestion run:', error)
      process.exit(1)
    }
    runId = newRun.id
  }

  // 7. Process chunks in batches
  let processed = 0
  let skipped = 0
  const chunksToProcess = chunks.slice(resumeFrom)

  console.log(`\n   Processing ${chunksToProcess.length} chunks (skipping first ${resumeFrom})...\n`)

  for (let batchStart = 0; batchStart < chunksToProcess.length; batchStart += BATCH_SIZE) {
    const batch = chunksToProcess.slice(batchStart, batchStart + BATCH_SIZE)

    // Layer 1: Deduplication — check which hashes already exist
    const hashes = batch.map((c) => c.chunkHash)
    const { data: existing } = await supabase
      .from('chunks')
      .select('chunk_hash')
      .eq('book_id', bookId)
      .in('chunk_hash', hashes)

    const existingHashes = new Set((existing ?? []).map((r: any) => r.chunk_hash))
    const newChunks = batch.filter((c) => !existingHashes.has(c.chunkHash))
    const skippedInBatch = batch.length - newChunks.length
    skipped += skippedInBatch

    if (newChunks.length > 0) {
      // Embed new chunks
      const texts = newChunks.map((c) => c.content)
      const embeddingResponse = await withRetry(() =>
        openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts, dimensions: EMBEDDING_DIMENSIONS })
      )

      const embeddings = embeddingResponse.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((d: any) => d.embedding)

      // Insert chunks with Layer 2 deduplication (ON CONFLICT DO NOTHING)
      const rows = newChunks.map((chunk, i) => ({
        book_id: bookId,
        chunk_index: chunk.chunkIndex + resumeFrom,
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
        console.error(`❌ Insert failed at batch ${batchStart}:`, insertError)
        await supabase
          .from('ingestion_runs')
          .update({ status: 'failed', error_message: insertError.message, completed_at: new Date().toISOString() })
          .eq('id', runId)
        process.exit(1)
      }

      processed += newChunks.length
    }

    const lastChunkIndex = resumeFrom + batchStart + batch.length - 1

    // Update run progress every batch
    await supabase
      .from('ingestion_runs')
      .update({ chunks_processed: processed, chunks_skipped: skipped, last_processed_chunk_index: lastChunkIndex })
      .eq('id', runId)

    const done = resumeFrom + batchStart + batch.length
    const pct = Math.round((done / chunks.length) * 100)
    process.stdout.write(`\r   Progress: ${done}/${chunks.length} chunks (${pct}%) — inserted: ${processed}, skipped: ${skipped}`)
  }

  console.log('\n')

  // 8. Finalize
  await supabase
    .from('ingestion_runs')
    .update({ status: 'completed', completed_at: new Date().toISOString(), chunks_processed: processed, chunks_skipped: skipped })
    .eq('id', runId)

  // Mark book as active and update chunk count
  await supabase
    .from('books')
    .update({ is_active: true, total_chunks: chunks.length })
    .eq('id', bookId)

  console.log(`✅ Ingestion complete!`)
  console.log(`   Book:     ${title} (${slug})`)
  console.log(`   Chunks:   ${chunks.length} total`)
  console.log(`   Inserted: ${processed}`)
  console.log(`   Skipped:  ${skipped} (duplicates)`)
  console.log(`   Run ID:   ${runId}`)
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err)
  process.exit(1)
})
