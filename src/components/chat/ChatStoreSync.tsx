'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { initializeChatStoreSync, stopChatStoreServerSync } from '@/store/chat'

export function ChatStoreSync() {
  const { data: session, status } = useSession()
  const userId = session?.user?.id

  useEffect(() => {
    if (status === 'authenticated' && userId) {
      initializeChatStoreSync(userId)
      return
    }
    if (status === 'unauthenticated') {
      stopChatStoreServerSync()
    }
  }, [status, userId])

  return null
}
