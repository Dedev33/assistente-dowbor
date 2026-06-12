import { Suspense } from 'react'
import EmbedChat from './EmbedChat'

export const metadata = {
  title: 'Assistente Dowbor',
  robots: 'noindex, nofollow',
}

export default function EmbedPage() {
  return (
    <Suspense>
      <EmbedChat />
    </Suspense>
  )
}
