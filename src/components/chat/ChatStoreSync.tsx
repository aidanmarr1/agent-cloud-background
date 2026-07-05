'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { initializeChatStoreSync } from '@/store/chat'

export function ChatStoreSync() {
  const { data: session, status } = useSession()
  const userId = session?.user?.id

  useEffect(() => {
    if (status !== 'authenticated' || !userId) return
    const startSync = () => initializeChatStoreSync(userId)
    const timeout = window.setTimeout(startSync, 1_000)
    return () => window.clearTimeout(timeout)
  }, [status, userId])

  return null
}
