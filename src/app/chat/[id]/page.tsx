'use client'

import dynamic from 'next/dynamic'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useCallback, useRef, useState, type CSSProperties } from 'react'
import { loadConversationFromServer, useChatStore } from '@/store/chat'
import { useUIStore } from '@/store/ui'
import { getTotalCredits, useCreditStore } from '@/store/credits'
import { useHydration } from '@/lib/useHydration'
import { hasActiveAgentStream, useAgentStream } from '@/stream/client/useAgentStream'
import { ModelSelector } from '@/components/ui/ModelSelector'
import { CreditPill } from '@/components/ui/CreditPill'
import { UserMenu } from '@/components/ui/UserMenu'
import { ProjectFiles } from '@/components/ui/ProjectFiles'
import { ControlTooltip } from '@/components/ui/ControlTooltip'
import { MessageList } from '@/components/chat/MessageList'
import { ChatInput } from '@/components/chat/ChatInput'
import { StepTrackerBar } from '@/components/chat/StepTrackerBar'
import { exportAsMarkdown, exportAsJSON, downloadFile } from '@/lib/exportConversation'
import { AlertCircle, RefreshCw, Home, Bot, Monitor, Sliders, LayoutGrid, MoreHorizontal, Download, Code, BarChart3, Search } from '@/components/icons'
import { ChatSkeleton } from '@/components/chat/ChatSkeleton'
import { OUT_OF_CREDITS_MESSAGE } from '@/lib/creditPolicy'
import { userErrorMessage } from '@/lib/errorMessages'

const ComputerPanel = dynamic(
  () => import('@/components/computer/ComputerPanel').then((mod) => mod.ComputerPanel),
  { ssr: false }
)
const InstructionsEditor = dynamic(
  () => import('@/components/chat/InstructionsEditor').then((mod) => mod.InstructionsEditor),
  { ssr: false }
)
const ArtifactGallery = dynamic(
  () => import('@/components/chat/ArtifactGallery').then((mod) => mod.ArtifactGallery),
  { ssr: false }
)
const ConversationSearch = dynamic(
  () => import('@/components/chat/ConversationSearch').then((mod) => mod.ConversationSearch),
  { ssr: false }
)

function visibleTaskError(error: string): string {
  const message = userErrorMessage(error, 'The task could not finish. Please try again.')
  if (/credits ran out|out of credits/i.test(message)) return message
  if (/timed out|timeout/i.test(message)) return 'The task took too long to respond. Please try again.'
  if (/stream ended|stopped before|did not return|no response body|request failed/i.test(message)) {
    return 'The task stopped before it finished. Please try again.'
  }
  if (/authentication|required|unauthorized/i.test(message)) return 'Please sign in again to continue.'
  if (/assistant service|openrouter|qwen|gemini|model|provider|api key|env\.local|function\.arguments|billable usage/i.test(message)) {
    return 'The assistant could not complete the request. Please try again.'
  }
  return message
}

export default function ChatPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const hydrated = useHydration()

  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === id))
  const setActiveId = useChatStore((s) => s.setActiveId)
  const truncateAfterMessage = useChatStore((s) => s.truncateAfterMessage)
  const computerPanelOpen = useUIStore((s) => s.computerPanelOpen)
  const toggleComputerPanel = useUIStore((s) => s.toggleComputerPanel)
  const isStreaming = useUIStore((s) => s.isStreaming)
  const webIdeMode = useUIStore((s) => s.webIdeMode)
  const computerPanelWidth = useUIStore((s) => s.computerPanelWidth)
  const conversationSearchOpen = useUIStore((s) => s.conversationSearchOpen)
  const setConversationSearchOpen = useUIStore((s) => s.setConversationSearchOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const addToast = useUIStore((s) => s.addToast)
  const creditBalance = useCreditStore((s) => s.balance)
  const totalCredits = getTotalCredits(creditBalance)

  const { sendMessage, handleStop, resumeActiveTask, streamError, clearError } = useAgentStream(id)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [taskBodyLoadFailed, setTaskBodyLoadFailed] = useState(false)
  const creditBlocked = streamError === OUT_OF_CREDITS_MESSAGE || /credits ran out|out of credits/i.test(streamError || '')

  const handleSlashAction = useCallback((action: string) => {
    if (action === '/export' && conversation) {
      const slug = conversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
      const md = exportAsMarkdown(conversation)
      downloadFile(md, `${slug}.md`, 'text/markdown')
    } else if (action === '/clear') {
      // Clear context: remove all messages but keep the task record.
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, messages: [], updatedAt: Date.now() } : c
        ),
      }))
    }
  }, [conversation, id])

  const revealServerSummaryForReplay = useCallback(() => {
    useChatStore.setState((state) => ({
      conversations: state.conversations.map((item) => {
        if (item.id !== id) return item
        // A newer server summary deliberately fences an older local body from
        // upload. Only placeholder summaries may be revealed for live replay.
        if (item.serverBodyStale) return item
        const { serverSummary, ...materialized } = item
        void serverSummary
        return { ...materialized, updatedAt: Date.now() }
      }),
    }))
  }, [id])

  useEffect(() => {
    setActiveId(id)
    // A prior crashed/aborted stream must never leave the input disabled after
    // opening or refreshing a task. But route transitions can happen while a
    // real stream is active, so preserve that state and keep the stop control.
    const hasLiveStream = hasActiveAgentStream(id)
    useUIStore.getState().setStreaming(hasLiveStream)
    if (hasLiveStream && !useUIStore.getState().streamingStatus) {
      useUIStore.getState().setStreamingStatus('thinking')
    }
    const uiState = useUIStore.getState()
    if (uiState.webIdeMode && uiState.webIdeConversationId !== id) {
      uiState.deactivateWebIde()
    }
  }, [id, setActiveId])

  useEffect(() => {
    if (!hydrated) return
    if (!conversation || !conversation.serverSummary || taskBodyLoadFailed) {
      useUIStore.getState().setRouteHandoffPending(false)
    }
  }, [hydrated, conversation, taskBodyLoadFailed])

  useEffect(() => {
    if (!hydrated || !conversation?.serverSummary) {
      setTaskBodyLoadFailed(false)
      return
    }

    let cancelled = false
    setTaskBodyLoadFailed(false)
    void (async () => {
      const loaded = await loadConversationFromServer(id)
      if (cancelled || loaded) return

      const resumed = await resumeActiveTask({ includeTerminalReplay: true }).catch((error) => {
        console.error('Task replay after body load failed:', error)
        return false
      })
      if (cancelled) return
      if (resumed) {
        revealServerSummaryForReplay()
        return
      }
      setTaskBodyLoadFailed(true)
    })()
    return () => {
      cancelled = true
    }
  }, [hydrated, id, conversation?.serverSummary, resumeActiveTask, revealServerSummaryForReplay])

  const handleRegenerate = useCallback(() => {
    if (!conversation) return
    const lastUserMsg = [...conversation.messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) {
      truncateAfterMessage(id, lastUserMsg.id)
      sendMessage(lastUserMsg.content, true)
    }
  }, [conversation, sendMessage, id, truncateAfterMessage])

  const openUsage = useCallback(() => {
    setSettingsTab('usage')
    setSettingsOpen(true)
  }, [setSettingsOpen, setSettingsTab])

  const handleContinueAfterCredits = useCallback(async () => {
    await useCreditStore.getState().syncFromServer({ force: true })
    if (useCreditStore.getState().getTotalCredits() <= 0) {
      addToast('Add credits before continuing this task.', 'error')
      return
    }
    clearError()
    handleRegenerate()
  }, [addToast, clearError, handleRegenerate])

  const resumeAttemptedConversationRef = useRef<string | null>(null)
  useEffect(() => {
    if (!hydrated || !conversation || conversation.serverSummary) return
    if (
      conversation.messages.length === 1 &&
      conversation.messages[0].role === 'user'
    ) {
      return
    }
    if (resumeAttemptedConversationRef.current === id) return
    resumeAttemptedConversationRef.current = id
    const latestMessage = conversation.messages[conversation.messages.length - 1]
    const latestAssistantLooksUnresolved = latestMessage?.role === 'assistant' && (
      (
        !latestMessage.content.trim() &&
        !(latestMessage.artifacts?.length) &&
        !(latestMessage.computerPanelData?.length)
      ) ||
      latestMessage.steps?.some((step) => step.status === 'running') ||
      latestMessage.taskGroups?.some((group) => (
        group.status === 'running' || group.subtasks?.some((subtask) => subtask.status === 'running')
      ))
    )
    const includeTerminalReplay = latestMessage?.role === 'user' || latestAssistantLooksUnresolved || (
      latestMessage?.role === 'assistant' &&
      !!latestMessage.streamRunId &&
      !latestMessage.streamTerminalStatus
    )
    void resumeActiveTask({ includeTerminalReplay }).catch((error) => {
      console.error('Task resume failed:', error)
    })
  }, [hydrated, id, conversation, resumeActiveTask])

  // Auto-send on first load
  const hasSentRef = useRef(false)
  const autoSendConversationRef = useRef(id)
  useEffect(() => {
    if (autoSendConversationRef.current !== id) {
      autoSendConversationRef.current = id
      hasSentRef.current = false
    }
    if (!hydrated || !conversation || hasSentRef.current) return
    if (
      conversation.messages.length === 1 &&
      conversation.messages[0].role === 'user'
    ) {
      if (hasActiveAgentStream(id)) {
        hasSentRef.current = true
        return
      }

      hasSentRef.current = true
      let cancelled = false

      void (async () => {
        const resumed = await resumeActiveTask({ includeTerminalReplay: true }).catch((error) => {
          console.error('Initial task resume failed:', error)
          return false
        })
        if (cancelled) return
        if (resumed) {
          revealServerSummaryForReplay()
          return
        }

        const uiState = useUIStore.getState()
        uiState.setStreaming(true)
        uiState.setStreamingStatus('startup')
        try {
          await sendMessage(conversation.messages[0].content, true)
        } catch (err) {
          console.error('Auto-send failed:', err)
          // Reset so a page reload (or re-mount) can retry the auto-send.
          // Without this, the user is stuck with an unanswered first message.
          if (!cancelled) {
            hasSentRef.current = false
            useUIStore.getState().addToast('Failed to send message. Please try again.', 'error')
          }
        }
      })()

      return () => {
        cancelled = true
      }
    }
  }, [hydrated, id, conversation, resumeActiveTask, sendMessage, revealServerSummaryForReplay])

  // Get computer panel data from the newest assistant message that still has
  // activity. During streaming, internal recovery can briefly remove the latest
  // placeholder; keep the panel mounted on the last real activity instead of
  // closing and reopening around every tool event.
  const assistantMessages = conversation?.messages.filter((m) => m.role === 'assistant') || []
  const lastAssistantMsg = assistantMessages[assistantMessages.length - 1]
  const latestConversationMessage = conversation?.messages[conversation.messages.length - 1]
  const trackerAssistantMsg = latestConversationMessage?.role === 'assistant'
    ? latestConversationMessage
    : undefined
  const panelAssistantMsg = [...assistantMessages]
    .reverse()
    .find((m) => (m.computerPanelData?.length || 0) > 0) || lastAssistantMsg
  const computerPanelData = panelAssistantMsg?.computerPanelData || []
  const hasComputerPanelContent = computerPanelData.length > 0 || webIdeMode
  const showComputerPanel = computerPanelOpen && (hasComputerPanelContent || isStreaming)

  // Auto-open computer panel when first tool call data arrives during streaming
  const prevPanelDataLen = useRef(0)
  useEffect(() => {
    const hadItems = prevPanelDataLen.current > 0
    const hasItems = computerPanelData.length > 0
    prevPanelDataLen.current = computerPanelData.length
    const desktopViewport = typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
    if (!hadItems && hasItems && isStreaming && !computerPanelOpen && desktopViewport) {
      useUIStore.getState().setComputerPanelOpen(true, { source: 'auto' })
    }
  }, [computerPanelData.length, isStreaming, computerPanelOpen])

  const [menuOpen, setMenuOpen] = useState(false)

  // Hydration skeleton
  if (!hydrated) {
    return <ChatSkeleton />
  }

  if (conversation?.serverSummary && !taskBodyLoadFailed) {
    return <ChatSkeleton />
  }

  // Task not found
  if (!conversation) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center flex flex-col items-center max-w-[360px] px-6">
          <div className="w-14 h-14 rounded-2xl bg-bg-secondary border border-border-primary flex items-center justify-center mb-5">
            <Bot size={24} className="text-text-muted" strokeWidth={1.75} />
          </div>
          <h2 className="text-[20px] text-text-primary [font-family:var(--font-display)] mb-2">Task not found</h2>
          <p className="text-[13px] text-text-tertiary mb-7 leading-relaxed">This task is no longer available.</p>
          <button
            onClick={() => router.push('/')}
            className="inline-flex items-center gap-2 px-5 h-10 bg-text-primary text-primary-foreground hover:opacity-90 rounded-lg text-[12.5px] font-semibold transition-all duration-200 active:scale-95"
          >
            <Home size={13} strokeWidth={2.25} />
            Back to home
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      data-chat-layout=""
      className="chat-split-layout flex h-[100dvh] min-h-[100dvh] overflow-hidden"
      style={{ '--computer-panel-width': `${computerPanelWidth}%` } as CSSProperties}
    >
      {/* Main area */}
      <div
        data-chat-main=""
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {/* Top bar */}
        <div className="relative z-40 flex h-16 min-w-0 flex-shrink-0 items-center gap-2 overflow-visible border-b border-border-secondary bg-bg-primary pl-14 pr-2 sm:gap-3 sm:pr-4 md:gap-4 md:px-7">
          <ModelSelector />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[12.5px] font-semibold tracking-[0] text-text-secondary sm:text-[13.5px]">
              {conversation.title}
            </span>
            {isStreaming && (
              <span className="hidden flex-shrink-0 items-center gap-1.5 text-[11px] font-medium text-text-tertiary lg:flex" aria-label="Task is working">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-blue" aria-hidden="true" />
                Working
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-shrink-0 items-center gap-1.5 sm:gap-2">
            {(hasComputerPanelContent || showComputerPanel) && (
              <button
                onClick={() => toggleComputerPanel()}
                aria-label={showComputerPanel ? 'Hide computer panel' : 'Show computer panel'}
                className={`subtle-icon-button h-9 w-9 rounded-full flex items-center justify-center gap-2 transition-all duration-150 active:scale-[0.96] sm:w-auto sm:px-3 ${
                  showComputerPanel ? 'is-active' : ''
                }`}
              >
                <Monitor size={14} strokeWidth={2.25} weight="regular" />
                <span className="text-[12.5px] font-semibold hidden sm:inline">Computer</span>
              </button>
            )}
            {/* Unified overflow menu */}
            <div className="group/tooltip relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="subtle-icon-button flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150 active:scale-[0.96]"
                aria-label="More task actions"
              >
                <MoreHorizontal size={16} strokeWidth={2.25} weight="regular" />
              </button>
              {!menuOpen && <ControlTooltip label="More actions" />}
              {menuOpen && (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-40"
                    onClick={() => setMenuOpen(false)}
                    aria-label="Close task actions"
                  />
                  <div
                    className="absolute right-0 top-full z-50 mt-1.5 w-60 overflow-hidden rounded-xl border border-border-primary p-1.5 menu-surface animate-scale-in"
                    style={{ boxShadow: 'var(--shadow-menu)' }}
                  >
                    <button
                      onClick={() => { setConversationSearchOpen(true); setMenuOpen(false) }}
                      className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150"
                    >
                      <Search size={13} className="text-text-muted" strokeWidth={2.25} />
                      Search in task
                    </button>
                    <button
                      onClick={() => { setInstructionsOpen(true); setMenuOpen(false) }}
                      className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150"
                    >
                      <Sliders size={13} className="text-text-muted" strokeWidth={2.25} />
                      Instructions
                    </button>
                    {(lastAssistantMsg?.artifacts?.length ?? 0) > 0 && (
                      <button
                        onClick={() => { setGalleryOpen(true); setMenuOpen(false) }}
                        className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150"
                      >
                      <LayoutGrid size={13} className="text-text-muted" strokeWidth={2.25} />
                      Created files
                      </button>
                    )}
                    <div className="h-px bg-border-primary my-1 -mx-1" />
                    <button
                      onClick={() => {
                        const slug = conversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
                        downloadFile(exportAsMarkdown(conversation), `${slug}.md`, 'text/markdown')
                        setMenuOpen(false)
                      }}
                      className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150"
                    >
                      <Download size={13} className="text-text-muted" strokeWidth={2.25} />
                      Export as Markdown
                    </button>
                    <button
                      onClick={() => {
                        const slug = conversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
                        downloadFile(exportAsJSON(conversation), `${slug}.json`, 'application/json')
                        setMenuOpen(false)
                      }}
                      className="w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150"
                    >
                      <Code size={13} className="text-text-muted" strokeWidth={2.25} />
                      Export as JSON
                    </button>
                  </div>
                </>
              )}
            </div>
            <div>
              <ProjectFiles conversationId={id} />
            </div>
            <div className="hidden min-[520px]:block">
              <CreditPill />
            </div>
            <div className="ml-1">
              <UserMenu />
            </div>
          </div>
        </div>

        {/* Task search */}
        {conversationSearchOpen && (
          <ConversationSearch
            messages={conversation.messages}
            onClose={() => setConversationSearchOpen(false)}
            onScrollToMessage={(msgId) => {
              document.getElementById(`msg-${msgId}`)?.scrollIntoView({ behavior: 'smooth' })
            }}
          />
        )}

        {/* Messages */}
        <MessageList
          messages={conversation.messages}
          conversationId={id}
          onFollowUp={sendMessage}
          onRegenerate={handleRegenerate}
        />

        {/* Credit cutoff banner */}
        {creditBlocked && (
          <div className="flex-shrink-0 px-3 pb-2 animate-fade-in-up sm:px-6">
            <div className="mx-auto flex max-w-[860px] flex-col gap-3 rounded-2xl border border-border-primary bg-bg-card px-4 py-3 sm:flex-row sm:items-center" style={{ boxShadow: 'var(--shadow-sm)' }}>
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-8 h-8 rounded-lg bg-bg-secondary flex items-center justify-center flex-shrink-0">
                  <AlertCircle size={15} className="text-text-secondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-text-primary">Credits ran out</div>
                  <div className="text-[12px] text-text-tertiary leading-snug">
                    Add credits or check usage, then continue this task. Current balance: {Math.max(0, totalCredits).toLocaleString()} credits.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:flex-shrink-0">
                <button
                  type="button"
                  onClick={openUsage}
                  className="h-8 inline-flex items-center gap-1.5 rounded-lg border border-border-primary bg-bg-secondary px-3 text-[12px] font-semibold text-text-secondary transition-all duration-150 hover:bg-bg-secondary hover:text-text-primary active:scale-95"
                >
                  <BarChart3 size={12} />
                  Check usage
                </button>
                <button
                  type="button"
                  onClick={handleContinueAfterCredits}
                  disabled={isStreaming}
                  className="h-8 inline-flex items-center gap-1.5 rounded-lg bg-text-primary px-3 text-[12px] font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={12} />
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error banner */}
        {streamError && !creditBlocked && (
          <div className="flex-shrink-0 px-3 pb-2 animate-fade-in-up sm:px-6">
            <div className="mx-auto flex max-w-[860px] flex-col gap-3 rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 sm:flex-row sm:items-center">
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--danger-bg-hover)]">
                <AlertCircle size={14} className="text-[var(--danger-icon)]" />
              </div>
              <span className="flex-1 text-[13px] leading-snug text-[var(--danger-text)]">{visibleTaskError(streamError)}</span>
              <button
                onClick={() => {
                  clearError()
                  handleRegenerate()
                }}
                disabled={isStreaming}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-[var(--danger-solid)] px-3.5 py-1.5 text-xs font-medium text-text-on-accent transition-colors hover:bg-[var(--danger-solid-hover)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Sticky footer stack: progress and composer share the same Manus-style footprint. */}
        <div className="flex-shrink-0 bg-bg-primary px-3 pt-2.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:px-5">
          <div className="task-composer-stack mx-auto w-full max-w-[860px]">
            {trackerAssistantMsg?.taskGroups && trackerAssistantMsg.taskGroups.length > 0 && (
              <StepTrackerBar taskGroups={trackerAssistantMsg.taskGroups} isStreaming={isStreaming} />
            )}
            <div className="relative z-[2]">
              <ChatInput
                onSubmit={(msg, attachments) => sendMessage(msg, attachments)}
                onStop={handleStop}
                onSlashAction={handleSlashAction}
                placeholder="Message Agent"
                conversationId={id}
                variant="thread"
              />
            </div>
          </div>
          <p className="mx-auto mt-2 max-w-[860px] text-center text-[10.5px] leading-4 text-text-muted">
            Agent can make mistakes. Double-check important information.
          </p>
        </div>
      </div>

      {/* Computer panel */}
      {showComputerPanel && (
        <ComputerPanel items={computerPanelData} conversationId={id} />
      )}

      {/* Instructions editor modal */}
      {instructionsOpen && (
        <InstructionsEditor
          open={instructionsOpen}
          onClose={() => setInstructionsOpen(false)}
          conversationId={id}
        />
      )}

      {/* Artifact gallery modal */}
      {galleryOpen && (
        <ArtifactGallery
          open={galleryOpen}
          onClose={() => setGalleryOpen(false)}
          artifacts={lastAssistantMsg?.artifacts || []}
        />
      )}
    </div>
  )
}
