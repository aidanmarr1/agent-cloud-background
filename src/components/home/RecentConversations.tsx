'use client'

import { useRouter } from 'next/navigation'
import { useChatStore } from '@/store/chat'
import { useHydration } from '@/lib/useHydration'
import { ArrowRight, ArrowUpRight, MessageSquare, Star, Paperclip } from '@/components/icons'

interface RecentConversationsProps {
  onStartConversation?: (message: string) => void
}

const examplePrompts = [
  'Help me plan a new project',
  'Explain how neural networks work',
  'Build me a landing page',
  'Research the best vacation spots in Spain',
]

const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000 // 15 minutes

function getRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return `${Math.floor(d / 7)}w ago`
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function RecentConversations({ onStartConversation }: RecentConversationsProps) {
  const hydrated = useHydration()
  const allConversations = useChatStore((s) => s.conversations)
  // Sort starred first, then by recency, then take top 6.
  const conversations = [...allConversations]
    .sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
    .slice(0, 6)
  const router = useRouter()

  if (!hydrated) return null

  // ─── Empty state ───────────────────────────────────────────────────────────
  if (conversations.length === 0) {
    return (
      <div className="w-full max-w-[820px] mx-auto mt-12 px-4">
        <div className="border-t border-border-primary pt-5">
          <div className="flex flex-col gap-1 text-center sm:flex-row sm:items-end sm:justify-between sm:text-left">
            <div>
              <div className="flex items-center justify-center gap-2 sm:justify-start">
                <MessageSquare size={13} className="text-text-muted" strokeWidth={2.2} />
                <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                  Recent tasks
                </h2>
              </div>
              <p className="mt-1 text-[13px] font-medium text-text-secondary">No saved tasks yet</p>
            </div>
            <p className="text-[11.5px] text-text-muted">Pick a starter or type your own task above.</p>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {examplePrompts.map((prompt, idx) => (
              <button
                key={prompt}
                onClick={() => onStartConversation?.(prompt)}
                className="group flex min-h-[46px] items-center gap-3 rounded-xl border border-border-primary bg-bg-card px-3.5 py-2.5 text-left transition-card hover:border-border-tertiary hover:bg-bg-secondary active:scale-[0.98]"
              >
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-border-primary bg-bg-secondary text-[10px] font-semibold tabular-nums text-text-muted">
                  {idx + 1}
                </span>
                <span className="flex-1 text-[12.5px] text-text-secondary transition-colors duration-[var(--dur-base)] ease-[var(--ease-out-expo)] group-hover:text-text-primary">
                  {prompt}
                </span>
                <ArrowUpRight
                  size={13}
                  strokeWidth={2}
                  className="flex-shrink-0 text-text-muted opacity-0 -translate-x-1 group-hover:translate-x-0 group-hover:opacity-100 transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-out-expo)]"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ─── Populated state ───────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-[820px] mx-auto mt-12 px-4">
      {/* Section header */}
      <div className="flex items-end justify-between mb-4 px-1">
        <div>
          <h2 className="text-[11px] text-text-muted uppercase tracking-[0.08em] font-medium leading-none">
            Recent tasks
          </h2>
        </div>
        {allConversations.length > 6 && (
          <span
            className="text-[11px] font-medium text-text-muted px-2.5 h-6 rounded-lg bg-bg-secondary border border-border-primary flex items-center gap-1 tabular-nums"
            title={`${allConversations.length} total`}
          >
            {allConversations.length} total
            <ArrowRight size={10} />
          </span>
        )}
      </div>

      {/* Task list */}
      <div className="space-y-1">
        {conversations.map((conv) => {
          const messageCount = conv.messages.length
          const lastMsg = conv.messages[conv.messages.length - 1]
          const preview = lastMsg ? stripMarkdown(lastMsg.content).slice(0, 110) : ''
          const isActive = Date.now() - conv.updatedAt < ACTIVE_THRESHOLD_MS
          const hasAttachments = conv.messages.some((m) => m.attachments && m.attachments.length > 0)

          return (
            <button
              key={conv.id}
              onClick={() => router.push(`/chat/${conv.id}`)}
              className="group w-full text-left flex items-center gap-3.5 px-3 py-3 rounded-xl border border-transparent hover:border-border-primary hover:bg-bg-secondary active:scale-[0.995] transition-card relative"
            >
              {/* Neutral icon container + live dot if recently updated */}
              <div className="relative w-10 h-10 rounded-xl bg-bg-tertiary border border-border-primary flex items-center justify-center flex-shrink-0 transition-colors duration-[var(--dur-base)] ease-[var(--ease-out-expo)] group-hover:bg-bg-card">
                <MessageSquare size={15} className="text-text-muted" strokeWidth={1.9} />
                {isActive && (
                  <span
                    className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-text-secondary border-2 border-bg-primary"
                    aria-label="Recently active"
                  />
                )}
              </div>

              {/* Title + preview */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {conv.starred && (
                    <Star
                      size={11}
                      strokeWidth={2.4}
                      className="flex-shrink-0 text-text-secondary fill-text-secondary"
                      aria-label="Starred"
                    />
                  )}
                  <span className="text-[14px] text-text-primary font-medium truncate tracking-[0] block">
                    {conv.title}
                  </span>
                  {hasAttachments && (
                    <Paperclip
                      size={11}
                      strokeWidth={2.2}
                      className="flex-shrink-0 text-text-muted"
                      aria-label="Has attachments"
                    />
                  )}
                </div>
                {preview && (
                  <div className="text-[12px] text-text-muted mt-0.5 truncate leading-relaxed">
                    {preview}
                  </div>
                )}
              </div>

              {/* Metadata */}
              <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                <span className="text-[10.5px] text-text-muted/80 tabular-nums font-medium">
                  {getRelativeTime(conv.updatedAt)}
                </span>
                <span className="text-[10px] text-text-muted/60 tabular-nums">
                  {messageCount} {messageCount === 1 ? 'turn' : 'turns'}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
