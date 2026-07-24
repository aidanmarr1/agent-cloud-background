'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { HeroSection } from '@/components/home/HeroSection'
import { QuickActions } from '@/components/home/QuickActions'
import { ModelSelector } from '@/components/ui/ModelSelector'
import { CreditPill } from '@/components/ui/CreditPill'
import { UserMenu } from '@/components/ui/UserMenu'
import { flushChatServerSync, useChatStore } from '@/store/chat'
import { useUIStore } from '@/store/ui'
import { bindAttachmentsToTask } from '@/lib/attachmentUpload'
import type { FileAttachment } from '@/types'
import { startInitialAgentTask } from '@/stream/client/useAgentStream'

export default function HomePage() {
  const router = useRouter()
  const createConversation = useChatStore((s) => s.createConversation)
  const addToast = useUIStore((s) => s.addToast)
  const [prefillText, setPrefillText] = useState('')
  const prefillFrameRef = useRef<number | null>(null)

  useEffect(() => {
    useUIStore.getState().setRouteHandoffPending(false)

    return () => {
      if (prefillFrameRef.current !== null) {
        cancelAnimationFrame(prefillFrameRef.current)
      }
    }
  }, [])

  const handleSubmit = async (message: string, attachments?: FileAttachment[]) => {
    const id = createConversation(message, attachments)
    const uiState = useUIStore.getState()
    uiState.setStreaming(true)
    uiState.setStreamingStatus('startup')
    uiState.setRouteHandoffPending(false)
    void startInitialAgentTask(id).catch((error) => {
      console.error('[Home] Failed to start task immediately after submit:', error)
      addToast('Failed to start task. Please try again.', 'error')
    })
    router.push(`/chat/${id}`)

    const chatState = useChatStore.getState()
    const firstMessageId = chatState
      .conversations
      .find((conversation) => conversation.id === id)
      ?.messages[0]?.id

    void (async () => {
      try {
        await bindAttachmentsToTask(attachments, id, firstMessageId)
      } catch (error) {
        console.error('[Home] Failed to bind attachments after navigation:', error)
        addToast('Task opened, but attachment syncing is still having trouble.', 'error')
      }

      try {
        await flushChatServerSync()
      } catch (error) {
        console.error('[Home] Failed to sync new task after navigation:', error)
        window.setTimeout(() => {
          void flushChatServerSync().catch((retryError) => {
            console.error('[Home] Retried task history sync failed:', retryError)
          })
        }, 1_500)
      }
    })()
  }

  const handleQuickAction = useCallback((prompt: string) => {
    if (prefillFrameRef.current !== null) {
      cancelAnimationFrame(prefillFrameRef.current)
    }

    // Reset first so selecting the same starter twice still updates and focuses the composer.
    setPrefillText('')
    prefillFrameRef.current = requestAnimationFrame(() => {
      setPrefillText(prompt)
      prefillFrameRef.current = null
    })
  }, [])

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <header className="absolute left-0 right-0 top-0 z-[80] flex h-14 items-center justify-between bg-bg-primary px-4 md:px-6">
        <div className="pl-10 md:pl-0">
          <ModelSelector />
        </div>
        <div className="flex items-center gap-3">
          <CreditPill />
          <UserMenu />
        </div>
      </header>

      <main className="relative flex min-h-screen items-center justify-center px-5 pb-8 pt-16 sm:px-8 md:pb-[12vh] lg:px-10">
        <div className="mx-auto flex w-full max-w-[900px] flex-col animate-home-enter">
          <HeroSection
            onSubmit={handleSubmit}
            prefillText={prefillText}
          />
          <QuickActions onAction={handleQuickAction} />
        </div>
      </main>
    </div>
  )
}
