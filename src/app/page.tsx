export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center space-y-4 px-4">
        <h1 className="text-3xl font-bold text-gray-900">
          Assistente de Pesquisa Dowbor.org
        </h1>
        <p className="text-gray-500 text-lg">Sistema RAG — em construção</p>
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-200 rounded-full text-sm text-green-700">
          <span className="w-2 h-2 bg-green-500 rounded-full inline-block animate-pulse" />
          Phase 0: Infraestrutura
        </div>
      </div>
    </main>
  )
}
