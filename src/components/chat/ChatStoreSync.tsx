'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { initializeChatStoreSync } from '@/store/chat'

export function ChatStoreSync() {
  const { data: session, status } = useSession()
  const userId = session?.user?.id

  useEffect(() => {
    if (status !== 'authenticated' || !userId) return
    initializeChatStoreSync(userId)
  }, [status, userId])

  return null
}
