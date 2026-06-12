'use client'

import { useState, useRef, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Book, Message, Citation,
  PDF_STORAGE_BASE, PDF_BOOK_SLUGS, BOOK_COVERS, BOOK_URLS,
  renderMarkdown, renderInline,
} from '@/lib/chat-shared'

const FULL_URL = 'https://assistente-dowbor.vercel.app'

export default function EmbedChat() {
  const searchParams = useSearchParams()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [books, setBooks] = useState<Book[]>([])
  const [fontScale, setFontScale] = useState<0 | 1 | 2>(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const autoSubmitted = useRef(false)

  useEffect(() => {
    const saved = localStorage.getItem('dowbor-font-size')
    if (saved === '1' || saved === '2') setFontScale(saved === '1' ? 1 : 2)
  }, [])

  useEffect(() => {
    document.documentElement.classList.remove('font-size-md', 'font-size-lg')
    if (fontScale === 1) document.documentElement.classList.add('font-size-md')
    if (fontScale === 2) document.documentElement.classList.add('font-size-lg')
    localStorage.setItem('dowbor-font-size', String(fontScale))
  }, [fontScale])

  useEffect(() => {
    fetch('/api/books')
      .then(r => r.json())
      .then(d => {
        const filtered = (d.books ?? []).filter((b: Book) => b.is_active && PDF_BOOK_SLUGS.has(b.slug))
        filtered.sort((a: Book, b: Book) => {
          if (a.slug === 'desafios-revolucao-digital') return -1
          if (b.slug === 'desafios-revolucao-digital') return 1
          return 0
        })
        setBooks(filtered)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
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
                citations: event.citations !== undefined ? event.citations : pendingCitations,
                is_fallback: pendingIsFallback,
                latency_ms: event.latency_ms,
                tokens: event.tokens,
                log_id: event.log_id ?? undefined,
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

  useEffect(() => {
    const q = searchParams.get('q')?.trim()
    if (q && !autoSubmitted.current) {
      autoSubmitted.current = true
      doChat(q)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleFeedback(msgIndex: number, vote: 'up' | 'down') {
    const msg = messages[msgIndex]
    if (!msg.log_id || msg.feedback) return
    setMessages(prev => {
      const next = [...prev]
      next[msgIndex] = { ...next[msgIndex], feedback: vote }
      return next
    })
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_id: msg.log_id, feedback: vote }),
      })
    } catch {
      // feedback is best-effort
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const query = input.trim()
      if (!query) return
      setInput('')
      doChat(query)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const query = input.trim()
    if (!query) return
    setInput('')
    doChat(query)
  }

  return (
    <div className="flex flex-col h-screen bg-white" style={{ fontFamily: 'var(--font-sans)' }}>

      {/* Header */}
      <header className="flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          <a
            href="https://dowbor.org"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-bold tracking-widest uppercase flex-shrink-0"
            style={{ color: 'var(--dowbor-red)' }}
          >
            DOWBOR.ORG
          </a>

          <div className="flex items-center gap-3 ml-auto">
            {/* Font size controls */}
            <div className="flex items-center gap-0.5">
              {([0, 1, 2] as const).map((level, i) => (
                <span key={level} className="flex items-center">
                  {i > 0 && <span className="text-gray-300 text-xs mx-0.5 select-none">|</span>}
                  <button
                    onClick={() => setFontScale(level)}
                    title={['Tamanho normal', 'Tamanho médio', 'Tamanho grande'][level]}
                    className="text-xs px-1 py-0.5 cursor-pointer bg-transparent border-0 transition-colors hover:opacity-70"
                    style={{
                      fontWeight: fontScale === level ? 700 : 400,
                      color: fontScale === level ? 'var(--dowbor-red)' : '#9CA3AF',
                    }}
                  >
                    {['A-', 'A', 'A+'][level]}
                  </button>
                </span>
              ))}
            </div>

            {/* Link to full platform */}
            <a
              href={FULL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-500 hover:opacity-70 transition-opacity whitespace-nowrap"
              title="Abrir versão completa"
            >
              Versão completa ↗
            </a>

            {/* Reset button */}
            <button
              className="text-xs tracking-widest uppercase text-gray-400 hover:opacity-60 transition-opacity cursor-pointer bg-transparent border-0 p-0 hidden sm:block"
              onClick={() => { setMessages([]); setInput('') }}
              title="Voltar ao início"
            >
              Assistente de Pesquisa
            </button>
          </div>
        </div>
        <div className="h-0.5 w-full" style={{ background: 'var(--dowbor-red)' }} />
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-2xl mx-auto space-y-5">

          {messages.length === 0 && (
            <div className="py-4">
              <h1 className="text-2xl text-gray-900 mb-2" style={{ fontFamily: 'var(--font-sentinel)', fontWeight: 400 }}>
                Assistente IA de Pesquisa
              </h1>
              <p className="text-sm text-gray-600 mb-5 text-justify leading-relaxed" style={{ fontFamily: 'var(--font-sentinel)', fontStyle: 'italic' }}>
                Explore o conteúdo de obras selecionadas por Ladislau Dowbor. Digite sua pergunta abaixo.
              </p>

              {/* Book covers */}
              {books.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">
                    {books.length} obras indexadas
                  </p>
                  <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
                    {books.map(b => (
                      <a
                        key={b.slug}
                        href={BOOK_URLS[b.slug]}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={b.title}
                        style={{ flexShrink: 0 }}
                      >
                        {BOOK_COVERS[b.slug] ? (
                          <img
                            src={BOOK_COVERS[b.slug]}
                            alt={b.title}
                            style={{
                              width: '56px',
                              height: '80px',
                              objectFit: 'cover',
                              display: 'block',
                              boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
                              transition: 'opacity 0.15s',
                            }}
                            onMouseOver={e => (e.currentTarget.style.opacity = '0.8')}
                            onMouseOut={e => (e.currentTarget.style.opacity = '1')}
                          />
                        ) : null}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-2">
                Exemplos
              </p>
              <div className="space-y-1">
                {[
                  'Quais são os principais desafios sistêmicos do capitalismo contemporâneo segundo Dowbor?',
                  'Como Dowbor relaciona desigualdade econômica, financeirização e crise democrática?',
                  'Como a revolução digital transforma as relações de trabalho e produção, segundo Dowbor?',
                ].map(s => (
                  <button
                    key={s}
                    onClick={() => { setInput(s); inputRef.current?.focus() }}
                    className="block w-full text-left text-sm text-gray-700 py-3 px-3 border-b border-gray-200 hover:bg-gray-50 hover:text-gray-900 transition-colors"
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
                    <div
                      className="max-w-[80%] px-4 py-3 text-sm text-white leading-relaxed"
                      style={{ background: 'var(--dowbor-red)', borderRadius: '4px' }}
                    >
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div className="max-w-2xl">
                    {msg.error ? (
                      <p className="text-sm text-red-600 italic" style={{ fontFamily: 'var(--font-serif)' }}>
                        {msg.content}
                      </p>
                    ) : (
                      <>
                        <div
                          className="text-sm text-gray-800 leading-relaxed max-w-prose"
                          style={{ fontFamily: 'var(--font-serif)' }}
                        >
                          {renderMarkdown(msg.content, isStreaming && (
                            <span
                              className="inline-block w-0.5 h-4 ml-0.5 align-middle animate-pulse"
                              style={{ background: 'var(--dowbor-red)' }}
                            />
                          ))}
                        </div>

                        {msg.citations && msg.citations.length > 0 && (
                          <div className="mt-4 pt-3 border-t border-gray-200">
                            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                              Fontes
                            </p>
                            <div className="space-y-1">
                              {msg.citations.map((c, j) => (
                                <p key={j} className="text-xs text-gray-600 italic" style={{ fontFamily: 'var(--font-serif)' }}>
                                  {c.book_title}
                                  {c.page_number && PDF_BOOK_SLUGS.has(c.book_slug) ? (
                                    <>
                                      {', '}
                                      <a
                                        href={`${PDF_STORAGE_BASE}/${c.book_slug}.pdf#page=${c.page_number}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="not-italic underline underline-offset-2 hover:opacity-70 font-semibold"
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

                        {msg.log_id && (
                          <div className="mt-3 flex items-center gap-2">
                            <span className="text-xs text-gray-400">Esta resposta foi útil?</span>
                            {msg.feedback ? (
                              <span className="text-xs text-gray-400">Obrigado.</span>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleFeedback(i, 'up')}
                                  title="Resposta útil"
                                  className="cursor-pointer bg-transparent border-0 p-0 hover:scale-110 transition-transform"
                                >👍</button>
                                <button
                                  onClick={() => handleFeedback(i, 'down')}
                                  title="Resposta não útil"
                                  className="cursor-pointer bg-transparent border-0 p-0 hover:scale-110 transition-transform"
                                >👎</button>
                              </>
                            )}
                          </div>
                        )}

                        {msg.suggestions && msg.suggestions.length > 0 && (
                          <div className="mt-4 pt-3 border-t border-gray-200">
                            <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-2">
                              Continue pesquisando
                            </p>
                            <div className="flex flex-col gap-1.5">
                              {msg.suggestions.map((q, j) => (
                                <button
                                  key={j}
                                  onClick={() => { setInput(''); doChat(q) }}
                                  disabled={loading}
                                  className="text-left text-sm py-2 px-3 border border-gray-200 rounded hover:border-red-300 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                  style={{ fontFamily: 'var(--font-serif)', color: '#374151' }}
                                >
                                  <span className="font-bold mr-1.5" style={{ color: 'var(--dowbor-red)' }}>→</span>
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
            )
          })}

          {loading && messages[messages.length - 1]?.content === '' && (
            <div className="flex items-center gap-2 py-1">
              <div className="flex gap-1">
                {[0, 150, 300].map(delay => (
                  <span
                    key={delay}
                    className="block w-2 h-2 rounded-full animate-bounce"
                    style={{ background: 'var(--dowbor-red)', animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
              <p className="text-sm text-gray-500 italic" style={{ fontFamily: 'var(--font-serif)' }}>
                Pesquisando nos livros...
              </p>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </main>

      {/* Input */}
      <footer className="flex-shrink-0 border-t border-gray-200 px-4 py-3 bg-white">
        <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
          <div
            className="rounded-lg overflow-hidden border-2 transition-colors"
            style={{ borderColor: input ? 'var(--dowbor-red)' : '#D1D5DB' }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Digite sua pergunta sobre os livros..."
              rows={2}
              className="w-full px-4 pt-3 pb-2 text-base text-gray-800 placeholder-gray-500 resize-none border-0 outline-none bg-white"
              style={{ fontFamily: 'var(--font-serif)', maxHeight: '100px', overflowY: 'auto' }}
              disabled={loading}
            />
            <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-gray-50">
              <span className="hidden sm:inline text-xs text-gray-400">
                Enter para enviar · Shift+Enter para nova linha
              </span>
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="px-5 py-2 text-sm font-semibold text-white rounded transition-opacity disabled:opacity-40 ml-auto"
                style={{ background: 'var(--dowbor-red)', minHeight: '36px', minWidth: '80px' }}
              >
                {loading ? 'Buscando...' : 'Enviar'}
              </button>
            </div>
          </div>
        </form>
      </footer>

    </div>
  )
}
