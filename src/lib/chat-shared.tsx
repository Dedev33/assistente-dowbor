export interface Book {
  slug: string
  title: string
  total_chunks: number | null
  is_active: boolean
}

export interface Citation {
  book_title: string
  book_slug: string
  page_number: number | null
  similarity: number
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
  latency_ms?: { embedding: number; retrieval: number; llm: number; total: number }
  tokens?: { embedding: number; llm_input: number; llm_output: number }
  is_fallback?: boolean
  suggestions?: string[]
  error?: boolean
  log_id?: string
  feedback?: 'up' | 'down'
}

export const PDF_STORAGE_BASE = 'https://speizjkskrftoutshfyf.supabase.co/storage/v1/object/public/books'

export const PDF_BOOK_SLUGS = new Set([
  'funcao-social-economia',
  'pao-nosso-cada-dia',
  'desafios-sistemicos',
  'tecnologia-do-conhecimento',
  'desafios-revolucao-digital',
  'desenvolvimento-local',
])

export const BOOK_COVERS: Record<string, string> = {
  'funcao-social-economia':     '/books/covers/funcao-social-economia.jpg',
  'pao-nosso-cada-dia':         '/books/covers/pao-nosso-cada-dia.png',
  'desafios-sistemicos':        '/books/covers/desafios-sistemicos.png',
  'tecnologia-do-conhecimento': '/books/covers/tecnologia-do-conhecimento.jpg',
  'desafios-revolucao-digital': '/books/covers/desafios-revolucao-digital.png',
  'desenvolvimento-local':      '/books/covers/desenvolvimento-local.png',
}

export const BOOK_URLS: Record<string, string> = {
  'funcao-social-economia':     'https://dowbor.org/2022/04/resgatar-a-funcao-social-da-economia-uma-questao-de-dignidade-humana.html',
  'pao-nosso-cada-dia':         'https://dowbor.org/2015/06/l-dowbor-o-pao-nosso-de-cada-dia-os-processos-produtivos-no-brasil-ed-fundacao-perseu-abramo-sao-paulo-2015144p-isbn-978-85-7643-266-1.html',
  'desafios-sistemicos':        'https://dowbor.org/2025/08/desafios-sistemicos-na-era-digital-juntando-as-pecas-do-quebra-cabeca.html',
  'tecnologia-do-conhecimento': 'https://dowbor.org/2013/06/l-dowbor-tecnologias-do-conhecimento-os-desafios-da-educacao-vozes-2013-85p-versao-atualizada.html',
  'desafios-revolucao-digital': 'https://dowbor.org/2024/06/revolucao-digital-uma-sociedade-a-beira-de-rupturas.html',
  'desenvolvimento-local':      'https://dowbor.org/2023/05/desenvolvimento-local-empoderar-a-comunidade.html',
}

export function renderInline(text: string): React.ReactNode {
  const parts = text.split(/\*\*/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <strong key={i}>{part}</strong> : part
      )}
    </>
  )
}

export function renderMarkdown(text: string, trailing?: React.ReactNode): React.ReactNode {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim())

  if (paragraphs.length === 0) {
    return trailing ? <p>{trailing}</p> : null
  }

  return (
    <>
      {paragraphs.map((para, pIdx) => {
        const isLast = pIdx === paragraphs.length - 1
        const lines = para.split('\n')
        const content: React.ReactNode[] = []

        lines.forEach((line, lIdx) => {
          const parts = line.split(/\*\*/)
          parts.forEach((part, i) => {
            if (i % 2 === 1) {
              content.push(<strong key={`s-${pIdx}-${lIdx}-${i}`}>{part}</strong>)
            } else if (part) {
              content.push(part)
            }
          })
          if (lIdx < lines.length - 1) {
            content.push(<br key={`br-${pIdx}-${lIdx}`} />)
          }
        })

        return (
          <p key={pIdx} className={pIdx < paragraphs.length - 1 ? 'mb-4' : ''}>
            {content}
            {isLast && trailing}
          </p>
        )
      })}
    </>
  )
}
