'use client'

import { useState, useRef, useEffect } from 'react'

interface Book {
  slug: string
  title: string
  total_chunks: number | null
  is_active: boolean
}

interface Citation {
  book_title: string
  book_slug: string
  page_number: number | null
  similarity: number
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
  latency_ms?: { embedding: number; retrieval: number; llm: number; total: number }
  tokens?: { embedding: number; llm_input: number; llm_output: number }
  is_fallback?: boolean
  suggestions?: string[]
  error?: boolean
}

// Render **bold** inline only — used for single-line contexts like suggestion buttons
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/\*\*/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <strong key={i}>{part}</strong> : part
      )}
    </>
  )
}

// Render markdown: blank-line-separated paragraphs, **bold** inline, single \n as <br />
function renderMarkdown(text: string, trailing?: React.ReactNode): React.ReactNode {
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

// Map slug → cover image path (served from /public/books/covers/)
const BOOK_COVERS: Record<string, string> = {
  'funcao-social-economia':     '/books/covers/funcao-social-economia.jpg',
  'pao-nosso-cada-dia':         '/books/covers/pao-nosso-cada-dia.png',
  'desafios-sistemicos':        '/books/covers/desafios-sistemicos.png',
  'tecnologia-do-conhecimento': '/books/covers/tecnologia-do-conhecimento.jpg',
}

const SUGGESTIONS = [
  'Quais conceitos aparecem transversalmente nos quatro livros?',
  'Como as ideias de Dowbor explicam o endividamento das famílias brasileiras?',
  'Como Dowbor enxerga o crédito como instrumento produtivo?',
  'A crítica de Dowbor é reformista ou estrutural?',
]

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [books, setBooks] = useState<Book[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch('/api/books')
      .then(r => r.json())
      .then(d => setBooks((d.books ?? []).filter((b: Book) => b.is_active)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function doChat(query: string) {
    if (!query || loading) return

    const history = messages
      .filter(m => !m.error)
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content }))

    setLoading(true)

    setMessages(prev => [
      ...prev,
      { role: 'user', content: query },
      { role: 'assistant', content: '' },
    ])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, top_k: 5, history }),
      })

      if (!res.ok || !res.body) {
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: 'Erro ao conectar com o servidor.', error: true },
        ])
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pendingCitations: Citation[] = []
      let pendingIsFallback = false
      let streamedContent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          let event: any
          try { event = JSON.parse(line) } catch { continue }

          if (event.type === 'meta') {
            pendingCitations = event.citations
            pendingIsFallback = event.is_fallback
            if (event.is_fallback) {
              setMessages(prev => {
                const next = [...prev]
                next[next.length - 1] = { ...next[next.length - 1], is_fallback: true }
                return next
              })
            }
          } else if (event.type === 'chunk') {
            streamedContent += event.text
            setMessages(prev => {
              const next = [...prev]
              next[next.length - 1] = { ...next[next.length - 1], content: streamedContent }
              return next
            })
          } else if (event.type === 'done') {
            setMessages(prev => {
              const next = [...prev]
              next[next.length - 1] = {
                role: 'assistant',
                content: streamedContent,
                citations: pendingCitations,
                is_fallback: pendingIsFallback,
                latency_ms: event.latency_ms,
                tokens: event.tokens,
              }
              return next
            })
          } else if (event.type === 'suggestions') {
            setMessages(prev => {
              const next = [...prev]
              next[next.length - 1] = { ...next[next.length - 1], suggestions: event.questions }
              return next
            })
          } else if (event.type === 'error') {
            setMessages(prev => [
              ...prev.slice(0, -1),
              { role: 'assistant', content: event.message ?? 'Erro desconhecido.', error: true },
            ])
          }
        }
      }
    } catch {
      setMessages(prev => [
        ...prev.slice(0, -1),
        { role: 'assistant', content: 'Erro de conexão com o servidor.', error: true },
      ])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const query = input.trim()
    if (!query) return
    setInput('')
    doChat(query)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e as unknown as React.FormEvent)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-white">

      {/* Header */}
      <header className="flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center justify-between px-8 py-4">
          <a
            href="https://dowbor.org"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-bold tracking-widest uppercase"
            style={{ color: 'var(--dowbor-red)', fontFamily: 'var(--font-sans)' }}
          >
            DOWBOR.ORG
          </a>
          {/* ↑ contrast: was text-gray-400, now text-gray-600 */}
          <span
            className="text-sm tracking-widest uppercase text-gray-600"
            style={{ fontFamily: 'var(--font-sans)' }}
          >
            Assistente de Pesquisa
          </span>
        </div>
        <div className="h-0.5 w-full" style={{ background: 'var(--dowbor-red)' }} />
      </header>

      <div className="flex flex-1 min-h-0">

        {/* Sidebar */}
        <aside className="w-72 border-r border-gray-200 flex flex-col flex-shrink-0 bg-white">
          <div className="px-7 pt-8 pb-5">
            <h2
              className="text-2xl leading-tight"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              Livros
            </h2>
            {/* ↑ contrast: was text-gray-400, now text-gray-600 */}
            <p className="text-sm text-gray-600 mt-1">
              {books.length} obras indexadas
            </p>
            <div className="mt-3 h-px" style={{ background: 'var(--dowbor-red)' }} />
          </div>

          <div className="px-7 flex-1 overflow-y-auto">
            {books.length === 0 ? (
              <p className="text-base text-gray-500 italic" style={{ fontFamily: 'var(--font-serif)' }}>
                Carregando...
              </p>
            ) : (
              <ul className="space-y-5">
                {books.map(b => (
                  <li key={b.slug} className="pb-5 border-b border-gray-200 last:border-0 flex gap-3 items-start">
                    {BOOK_COVERS[b.slug] && (
                      <img
                        src={BOOK_COVERS[b.slug]}
                        alt={b.title}
                        style={{ width: '52px', height: '74px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 2px 6px rgba(0,0,0,0.22)' }}
                      />
                    )}
                    <div className="min-w-0">
                      {/* ↑ font size: was text-sm, now text-base */}
                      <p
                        className="text-base leading-snug text-gray-800 italic"
                        style={{ fontFamily: 'var(--font-serif)' }}
                      >
                        {b.title}
                      </p>
                      {/* ↑ contrast: was text-xs text-gray-400, now text-sm text-gray-600 */}
                      <p className="text-sm text-gray-600 mt-1">
                        Ladislau Dowbor
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="px-7 py-6 border-t border-gray-200">
            {/* ↑ contrast: was text-xs text-gray-400, now text-sm text-gray-600 */}
            <p className="text-sm text-gray-600 leading-relaxed">
              Pesquisa semântica nos livros disponíveis gratuitamente em dowbor.org
            </p>
          </div>
        </aside>

        {/* Main chat area */}
        <div className="flex flex-col flex-1 min-w-0">

          {/* Messages */}
          <main className="flex-1 overflow-y-auto px-10 py-8">
            <div className="max-w-2xl mx-auto space-y-8">

              {messages.length === 0 && (
                <div className="py-12">
                  <h1
                    className="text-4xl text-gray-800 mb-3"
                    style={{ fontFamily: 'var(--font-serif)' }}
                  >
                    O que você quer saber?
                  </h1>
                  {/* ↑ contrast: was text-sm text-gray-400, now text-base text-gray-600 */}
                  <p className="text-base text-gray-600 mb-8">
                    Faça uma pergunta sobre os livros de Ladislau Dowbor
                  </p>
                  <div className="space-y-1">
                    {SUGGESTIONS.map(s => (
                      <button
                        key={s}
                        onClick={() => { setInput(s); inputRef.current?.focus() }}
                        /* ↑ font size: was text-sm, now text-base. Contrast: was text-gray-600, now text-gray-700. Padding: py-4 for larger touch target */
                        className="block w-full text-left text-base text-gray-700 py-4 px-3 border-b border-gray-200 hover:bg-gray-50 hover:text-gray-900 transition-colors rounded-sm"
                        style={{ fontFamily: 'var(--font-serif)' }}
                      >
                        <span className="mr-2 font-bold" style={{ color: 'var(--dowbor-red)' }}>→</span>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => {
                const isStreaming = loading && i === messages.length - 1 && msg.role === 'assistant'
                return (
                <div key={i}>
                  {msg.role === 'user' ? (
                    <div className="flex justify-end">
                      {/* ↑ font size: was text-sm, now text-base */}
                      <div
                        className="max-w-lg px-5 py-4 text-base text-white leading-relaxed"
                        style={{ background: 'var(--dowbor-red)', borderRadius: '4px' }}
                      >
                        {msg.content}
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-2xl">
                      {msg.error ? (
                        /* ↑ font size: was text-sm, now text-base */
                        <p className="text-base text-red-600 italic" style={{ fontFamily: 'var(--font-serif)' }}>
                          {msg.content}
                        </p>
                      ) : (
                        <>
<div
                            className="text-base text-gray-800 leading-relaxed max-w-prose text-justify"
                            style={{ fontFamily: 'var(--font-serif)' }}
                          >
                            {renderMarkdown(msg.content, isStreaming && (
                              <span
                                className="inline-block w-0.5 h-5 ml-0.5 align-middle animate-pulse"
                                style={{ background: 'var(--dowbor-red)' }}
                              />
                            ))}
                          </div>

                          {msg.citations && msg.citations.length > 0 && (
                            <div className="mt-5 pt-4 border-t border-gray-200">
                              {/* ↑ contrast: was text-xs text-gray-400, now text-sm text-gray-600 */}
                              <p className="text-sm font-semibold uppercase tracking-widest text-gray-600 mb-3">
                                Fontes
                              </p>
                              <div className="space-y-2">
                                {msg.citations.map((c, j) => (
                                  /* ↑ font size: was text-xs, now text-sm. Contrast: was text-gray-500, now text-gray-700. Removed % similarity */
                                  <p key={j} className="text-sm text-gray-700 italic" style={{ fontFamily: 'var(--font-serif)' }}>
                                    {c.book_title}
                                    {c.page_number ? (
                                      <>
                                        {', '}
                                        <a
                                          href={`/books/${c.book_slug}.pdf#page=${c.page_number}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="not-italic underline underline-offset-2 hover:opacity-70 transition-opacity font-semibold"
                                          style={{ color: 'var(--dowbor-red)' }}
                                        >
                                          página {c.page_number}
                                        </a>
                                      </>
                                    ) : ''}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}
                          {msg.suggestions && msg.suggestions.length > 0 && (
                            <div className="mt-5 pt-4 border-t border-gray-200">
                              <p className="text-sm font-semibold uppercase tracking-widest text-gray-500 mb-3">
                                Continue pesquisando
                              </p>
                              <div className="flex flex-col gap-2">
                                {msg.suggestions.map((q, j) => (
                                  <button
                                    key={j}
                                    onClick={() => { setInput(''); doChat(q) }}
                                    disabled={loading}
                                    className="text-left text-base py-3 px-4 border border-gray-200 rounded-lg hover:border-red-300 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    style={{ fontFamily: 'var(--font-serif)', color: '#374151' }}
                                  >
                                    <span className="font-bold mr-2" style={{ color: 'var(--dowbor-red)' }}>→</span>
                                    {renderInline(q)}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                )})}

              {/* Loading indicator — more prominent, with animated dots */}
              {loading && messages[messages.length - 1]?.content === '' && (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex gap-1.5">
                    {[0, 150, 300].map(delay => (
                      <span
                        key={delay}
                        className="block w-2.5 h-2.5 rounded-full animate-bounce"
                        style={{ background: 'var(--dowbor-red)', animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </div>
                  {/* ↑ font size: was text-base, now text-lg. Contrast: was text-gray-400, now text-gray-600 */}
                  <p className="text-lg text-gray-600 italic" style={{ fontFamily: 'var(--font-serif)' }}>
                    Pesquisando nos livros...
                  </p>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </main>

          {/* Input area — full border, larger textarea, real send button */}
          <footer className="flex-shrink-0 border-t-2 border-gray-200 px-10 py-6 bg-white">
            <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
              <div
                className="rounded-lg overflow-hidden border-2 transition-colors"
                style={{ borderColor: input ? 'var(--dowbor-red)' : '#D1D5DB' }}
              >
                {/* ↑ font size: was text-base, now text-lg. Placeholder contrast improved. Rows: 1→2 */}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Digite sua pergunta sobre os livros..."
                  rows={2}
                  className="w-full px-5 pt-4 pb-2 text-lg text-gray-800 placeholder-gray-500 resize-none border-0 outline-none bg-white"
                  style={{ fontFamily: 'var(--font-serif)', maxHeight: '140px', overflowY: 'auto' }}
                  disabled={loading}
                  autoFocus
                />
                <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 bg-gray-50">
                  {/* ↑ contrast: was text-xs text-gray-300, now text-sm text-gray-500 */}
                  <span className="text-sm text-gray-500">
                    Enter para enviar · Shift+Enter para nova linha
                  </span>
                  {/* ↑ real button with background, min-height 44px */}
                  <button
                    type="submit"
                    disabled={loading || !input.trim()}
                    className="px-6 py-2 text-base font-semibold text-white rounded transition-opacity disabled:opacity-40"
                    style={{ background: 'var(--dowbor-red)', fontFamily: 'var(--font-sans)', minHeight: '44px', minWidth: '96px' }}
                  >
                    {loading ? 'Buscando...' : 'Enviar'}
                  </button>
                </div>
              </div>
            </form>
          </footer>

        </div>
      </div>
    </div>
  )
}
