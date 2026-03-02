#!/usr/bin/env npx ts-node
/**
 * Uploads the 4 book PDFs to Supabase Storage bucket "books".
 * Creates the bucket if it doesn't exist (public read access).
 * PDFs are renamed to slug-based names for stable URLs.
 *
 * Usage: npm run upload-pdfs
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import * as fs from 'fs'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const BUCKET = 'books'

const FILES = [
  { localPath: '23-TecnDoCnh2013.pdf',                   storageName: 'tecnologia-do-conhecimento.pdf' },
  { localPath: '25-Desafios-sistemicos.pdf',              storageName: 'desafios-sistemicos.pdf'         },
  { localPath: 'Resgatarafuncaosocialdaeconomia_WEB.pdf', storageName: 'funcao-social-economia.pdf'      },
  { localPath: 'paonossodecadadia_comcapa.pdf',           storageName: 'pao-nosso-cada-dia.pdf'          },
]

async function main() {
  // 1. Ensure bucket exists and is public
  const { data: buckets } = await supabase.storage.listBuckets()
  const exists = buckets?.some(b => b.name === BUCKET)

  if (!exists) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true })
    if (error) {
      console.error('❌ Failed to create bucket:', error.message)
      process.exit(1)
    }
    console.log(`✅ Created bucket "${BUCKET}" (public)`)
  } else {
    console.log(`   Bucket "${BUCKET}" already exists`)
  }

  // 2. Upload each PDF
  for (const { localPath, storageName } of FILES) {
    const fullPath = path.resolve(localPath)
    if (!fs.existsSync(fullPath)) {
      console.warn(`   ⚠ File not found, skipping: ${localPath}`)
      continue
    }

    const fileBuffer = fs.readFileSync(fullPath)
    const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1)

    process.stdout.write(`   Uploading ${storageName} (${fileSizeMB} MB)... `)

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storageName, fileBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      })

    if (error) {
      console.log(`❌ ${error.message}`)
    } else {
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(storageName)
      console.log(`✅  ${data.publicUrl}`)
    }
  }

  // 3. Print summary of public URLs
  console.log('\n📋 Public URLs for page.tsx:\n')
  for (const { storageName } of FILES) {
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(storageName)
    console.log(`  ${storageName.replace('.pdf', '')}:`)
    console.log(`    ${data.publicUrl}\n`)
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
