'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { HeroSection, getTimeBand, type TimeDisplay } from '@/components/home/HeroSection'
import { QuickActions } from '@/components/home/QuickActions'
import { LaunchCard } from '@/components/home/LaunchCard'
import { ModelSelector } from '@/components/ui/ModelSelector'
import { CreditPill } from '@/components/ui/CreditPill'
import { UserMenu } from '@/components/ui/UserMenu'
import { flushChatServerSync, useChatStore } from '@/store/chat'
import { useUIStore } from '@/store/ui'
import { bindAttachmentsToTask } from '@/lib/attachmentUpload'
import type { FileAttachment } from '@/types'

const DEFAULT_TIME_DISPLAY: TimeDisplay = {
  band: 'afternoon',
  todayLabel: 'Today',
}

export default function HomePage() {
  const router = useRouter()
  const createConversation = useChatStore((s) => s.createConversation)
  const addToast = useUIStore((s) => s.addToast)
  const [prefillText, setPrefillText] = useState('')
  const [timeDisplay, setTimeDisplay] = useState<TimeDisplay>(DEFAULT_TIME_DISPLAY)

  useEffect(() => {
    useUIStore.getState().setRouteHandoffPending(false)
    const now = new Date()
    setTimeDisplay({
      band: getTimeBand(now.getHours()),
      todayLabel: now.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    })
  }, [])

  const handleSubmit = async (message: string, attachments?: FileAttachment[]) => {
    const id = createConversation(message, attachments)
    const uiState = useUIStore.getState()
    uiState.setStreaming(true)
    uiState.setStreamingStatus('startup')
    uiState.setRouteHandoffPending(true)
    router.push(`/chat/${id}`)

    const chatState = useChatStore.getState()
    const firstMessageId = chatState
      .conversations
      .find((conversation) => conversation.id === id)
      ?.messages[0]?.id
    const hasAttachments = Boolean(
      attachments?.some((attachment) => typeof attachment.id === 'string' && attachment.id.length > 0),
    )

    void (async () => {
      try {
        await bindAttachmentsToTask(attachments, id, firstMessageId)
      } catch (error) {
        console.error('[Home] Failed to bind attachments after navigation:', error)
        if (hasAttachments) {
          addToast('Attachment syncing is lagging, but the task is starting.', 'error')
        }
      }

      try {
        await flushChatServerSync()
      } catch (error) {
        console.error('[Home] Failed to sync new task history after navigation:', error)
        addToast('Task opened, but history sync is still catching up.', 'error')
      }
    })()
  }

  const handleQuickAction = (prompt: string) => {
    setPrefillText(prompt)
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 h-12 flex items-center justify-between px-4 z-[80] md:px-6">
        <div className="pl-10 md:pl-0">
          <ModelSelector />
        </div>
        <div className="flex items-center gap-2">
          <CreditPill />
          <UserMenu />
        </div>
      </div>

      <div className="relative flex min-h-screen flex-col items-center justify-center px-3 py-[clamp(5.25rem,8vh,6.5rem)]">
        <div className="flex w-full translate-y-7 flex-col items-center justify-center animate-home-enter md:translate-y-8">
          <HeroSection
            onSubmit={handleSubmit}
            prefillText={prefillText}
            timeDisplay={timeDisplay}
          />
          <QuickActions onAction={handleQuickAction} />
          <LaunchCard />
        </div>
      </div>
    </div>
  )
}
