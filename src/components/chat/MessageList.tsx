'use client'

import { useEffect, useRef, useCallback, useState, useMemo, memo } from 'react'
import { Message, ConversationBranch } from '@/types'
import { UserMessage } from './UserMessage'
import { AgentMessage } from './AgentMessage'
import { BranchIndicator } from './BranchIndicator'
import { useUIStore } from '@/store/ui'
import { useChatStore } from '@/store/chat'
import { useVirtualizedList } from '@/lib/useVirtualizedList'
import { ArrowDown, MessageSquare } from '@/components/icons'

// Memoized message wrappers to prevent re-renders of unchanged messages
const MemoizedUserMessage = memo(function MemoizedUserMessage({
  message,
  hasBranches,
  conversationId,
  branches,
}: {
  message: Message
  hasBranches: boolean
  conversationId?: string
  branches?: ConversationBranch[]
}) {
  return (
    <div id={`msg-${message.id}`}>
      <UserMessage message={message} />
      {hasBranches && conversationId && branches && (
        <BranchIndicator conversationId={conversationId} branches={branches} />
      )}
    </div>
  )
})

const MemoizedAgentMessage = memo(function MemoizedAgentMessage({
  message,
  isLastAssistant,
  isStreaming,
  onFollowUp,
  onRegenerate,
  conversationId,
}: {
  message: Message
  isLastAssistant: boolean
  isStreaming: boolean
  onFollowUp?: (text: string) => void
  onRegenerate?: () => void
  conversationId?: string
}) {
  return (
    <div id={`msg-${message.id}`}>
      <AgentMessage
        message={message}
        isStreaming={isLastAssistant && isStreaming}
        onFollowUp={isLastAssistant ? onFollowUp : undefined}
        onRegenerate={isLastAssistant ? onRegenerate : undefined}
        conversationId={conversationId}
      />
    </div>
  )
})

// Threshold for enabling virtualization
const VIRTUALIZATION_THRESHOLD = 20
const FOLLOW_BOTTOM_THRESHOLD_PX = 120
const SHOW_SCROLL_TO_BOTTOM_THRESHOLD_PX = 240

interface MessageListProps {
  messages: Message[]
  conversationId?: string
  onFollowUp?: (text: string) => void
  onRegenerate?: () => void
}

export function MessageList({ messages, conversationId, onFollowUp, onRegenerate }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const isStreaming = useUIStore((s) => s.isStreaming)
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId))

  // Pre-compute the index of the last assistant message
  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  }, [messages])

  const shouldVirtualize = messages.length > VIRTUALIZATION_THRESHOLD

  // Volatile keys: the last assistant message while streaming (height changes constantly)
  const volatileKeys = useMemo(() => {
    if (!isStreaming || lastAssistantIndex < 0) return undefined
    return new Set([messages[lastAssistantIndex].id])
  }, [isStreaming, lastAssistantIndex, messages])

  // Always render the last 2 messages outside the virtualizer for streaming support
  const alwaysRenderLast = shouldVirtualize ? Math.min(2, messages.length) : 0

  const {
    startIndex,
    endIndex,
    totalHeight,
    offsetTop,
    measureRef,
    containerRef,
  } = useVirtualizedList({
    itemCount: messages.length,
    getItemKey: useCallback((i: number) => messages[i]?.id ?? String(i), [messages]),
    overscan: 3,
    alwaysRenderLast,
    estimatedItemHeight: 190,
    volatileKeys,
  })

  // Track whether the user manually scrolled up (vs auto-scroll putting them near bottom)
  const userScrolledUp = useRef(false)
  const lastConversationId = useRef<string | undefined>(conversationId)
  const lastMessageId = useRef<string | undefined>(messages[messages.length - 1]?.id)

  const distanceFromBottom = useCallback((el: HTMLDivElement) => (
    el.scrollHeight - el.scrollTop - el.clientHeight
  ), [])

  const setScrollLockFromPosition = useCallback((el: HTMLDivElement) => {
    const distance = distanceFromBottom(el)
    const isAwayFromBottom = distance > FOLLOW_BOTTOM_THRESHOLD_PX
    userScrolledUp.current = isAwayFromBottom
    setIsScrolledUp(distance > SHOW_SCROLL_TO_BOTTOM_THRESHOLD_PX)
  }, [distanceFromBottom])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setScrollLockFromPosition(el)
  }, [containerRef, setScrollLockFromPosition])

  // Attach our scroll handler alongside the virtualizer's
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [containerRef, handleScroll])

  // Track message content changes for scroll triggers during streaming
  const lastMsg = messages[messages.length - 1]
  const lastAssistantMsg = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined
  const scrollTrigger = useMemo(() =>
    lastAssistantMsg
      ? (lastAssistantMsg.content?.length || 0) + (Array.isArray(lastAssistantMsg.taskGroups)
        ? lastAssistantMsg.taskGroups.reduce((a, g) => {
            const subtasks = Array.isArray(g.subtasks) ? g.subtasks : []
            const narrations = Array.isArray(g.narrations) ? g.narrations : []
            return a + subtasks.length + narrations.length
          }, 0)
        : 0)
      : 0
  , [lastAssistantMsg])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const conversationChanged = lastConversationId.current !== conversationId
    const lastMessageChanged = lastMessageId.current !== lastMsg?.id
    const latestMessageIsUser = lastMsg?.role === 'user'
    const shouldForceForUserTurn = lastMessageChanged && latestMessageIsUser
    const shouldFollowStream = !userScrolledUp.current

    if (conversationChanged || shouldForceForUserTurn || shouldFollowStream) {
      bottomRef.current?.scrollIntoView({
        behavior: isStreaming || conversationChanged || shouldForceForUserTurn ? 'auto' : 'smooth',
      })
      requestAnimationFrame(() => {
        if (containerRef.current) setScrollLockFromPosition(containerRef.current)
      })
    }

    lastConversationId.current = conversationId
    lastMessageId.current = lastMsg?.id
  }, [conversationId, containerRef, isStreaming, lastMsg?.id, lastMsg?.role, scrollTrigger, setScrollLockFromPosition])

  const scrollToBottom = useCallback(() => {
    userScrolledUp.current = false
    setIsScrolledUp(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const showTyping = isStreaming && lastMsg?.role === 'user'

  // Render a single message by index
  const renderMessage = (msg: Message, i: number, ref?: (el: HTMLElement | null) => void) => {
    const previousRole = messages[i - 1]?.role
    const nextRole = messages[i + 1]?.role

    if (msg.role === 'user') {
      const hasBranches = conversation?.branches?.some(b => b.parentMessageId === msg.id) ?? false
      const topSpacing = i === 0
        ? 'pt-5'
        : previousRole === 'assistant'
          ? 'pt-5'
          : 'pt-3'
      return (
        <div key={msg.id} ref={ref} className={`${topSpacing} pb-3`}>
          <MemoizedUserMessage
            message={msg}
            hasBranches={hasBranches}
            conversationId={conversationId}
            branches={hasBranches ? conversation!.branches!.filter(b => b.parentMessageId === msg.id) : undefined}
          />
        </div>
      )
    }

    const closesTurn = nextRole === 'user'
    return (
      <div
        key={msg.id}
        ref={ref}
        className={`pt-7 ${closesTurn ? 'pb-5' : 'pb-6'}`}
      >
        <MemoizedAgentMessage
          message={msg}
          isLastAssistant={i === lastAssistantIndex}
          isStreaming={isStreaming}
          onFollowUp={onFollowUp}
          onRegenerate={onRegenerate}
          conversationId={conversationId}
        />
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div
        ref={containerRef}
        className="relative flex-1 overflow-y-auto px-4 py-6 sm:px-7 sm:py-8"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[860px] items-center justify-center">
          <div className="max-w-sm px-4 text-center animate-fade-in">
            <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border-primary bg-bg-card text-text-muted" style={{ boxShadow: 'var(--shadow-sm)' }}>
              <MessageSquare size={17} />
            </span>
            <h2 className="text-[14px] font-semibold text-text-primary">This task is ready</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-muted">Add a direction below to start a new turn.</p>
          </div>
        </div>
      </div>
    )
  }

  // Non-virtualized render for short conversations
  if (!shouldVirtualize) {
    return (
      <div
        ref={containerRef}
        className="relative flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7 lg:px-10"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        aria-busy={isStreaming}
      >
        <div className="mx-auto w-full max-w-[860px]">
          {messages.map((msg, i) => renderMessage(msg, i))}
          {showTyping && (
            <div className="pt-3 pb-6">
              <AgentMessage
                message={{
                  id: 'pending-agent-message',
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                  artifacts: [],
                  computerPanelData: [],
                }}
                isStreaming
              />
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {isScrolledUp && (
          <div className="sticky bottom-4 flex justify-center pointer-events-none z-10">
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="Scroll to bottom"
              className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-border-primary bg-bg-card text-text-secondary transition-all duration-200 hover:-translate-y-0.5 hover:bg-bg-secondary hover:text-text-primary animate-slide-up"
              style={{ boxShadow: 'var(--shadow-lg)' }}
            >
              <ArrowDown size={12} strokeWidth={2.5} />
            </button>
          </div>
        )}
      </div>
    )
  }

  // Virtualized render for long conversations
  const virtualizedEnd = messages.length - alwaysRenderLast
  const tailMessages = messages.slice(virtualizedEnd)

  return (
    <div
    ref={containerRef}
      className="relative flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7 lg:px-10"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      aria-busy={isStreaming}
    >
      <div className="mx-auto w-full max-w-[860px]">
        {/* Virtualized portion */}
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetTop}px)` }}>
            {messages.slice(startIndex, Math.min(endIndex, virtualizedEnd)).map((msg, offset) => {
              const i = startIndex + offset
              return renderMessage(msg, i, measureRef(i))
            })}
          </div>
        </div>

        {/* Always-rendered tail (last 2 messages for streaming) */}
        {tailMessages.map((msg, offset) => {
          const i = virtualizedEnd + offset
          return renderMessage(msg, i)
        })}

        {showTyping && (
          <div className="pt-3 pb-6">
            <AgentMessage
              message={{
                id: 'pending-agent-message',
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                artifacts: [],
                computerPanelData: [],
              }}
              isStreaming
            />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {isScrolledUp && (
        <div className="sticky bottom-4 flex justify-center pointer-events-none z-10">
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            className="pointer-events-auto flex h-9 items-center gap-2 rounded-full border border-border-primary bg-bg-card px-4 text-[12px] font-semibold text-text-secondary transition-all duration-200 hover:-translate-y-0.5 hover:bg-bg-secondary hover:text-text-primary animate-slide-up"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <ArrowDown size={12} />
            {isStreaming ? 'New messages' : 'Scroll to bottom'}
          </button>
        </div>
      )}
    </div>
  )
}
