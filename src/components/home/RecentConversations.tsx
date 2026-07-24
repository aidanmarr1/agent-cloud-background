'use client'

import { useRouter } from 'next/navigation'
import { useChatStore } from '@/store/chat'
import { useHydration } from '@/lib/useHydration'
import { ChevronRight, MessageSquare, Star } from '@/components/icons'

function getRelativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
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

export function RecentConversations() {
  const hydrated = useHydration()
  const allConversations = useChatStore((s) => s.conversations)
  const conversations = [...allConversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)
  const router = useRouter()

  if (!hydrated) {
    return (
      <section
        className="order-2 w-full overflow-hidden rounded-[20px] border border-border-primary bg-bg-card shadow-[var(--shadow-sm)] lg:order-1"
        aria-labelledby="recent-tasks-heading"
        aria-busy="true"
      >
        <div>
          <div className="px-5 pb-4 pt-5">
          <h2 id="recent-tasks-heading" className="text-[16px] font-semibold tracking-[-0.015em] text-text-primary">
            Continue
          </h2>
          <p className="mt-1 text-[12px] text-text-muted">Pick up where you left off.</p>
          </div>
          <div className="border-t border-border-primary" aria-hidden="true">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="flex h-[72px] animate-pulse items-center gap-3 border-b border-border-secondary px-5 last:border-b-0"
              >
                <span className="h-8 w-8 rounded-lg bg-bg-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block h-3 w-40 max-w-full rounded bg-bg-secondary" />
                  <span className="mt-2 block h-2.5 w-64 max-w-[75%] rounded bg-bg-secondary" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    )
  }

  if (conversations.length === 0) {
    return (
      <section
        className="order-2 w-full overflow-hidden rounded-[20px] border border-border-primary bg-bg-card shadow-[var(--shadow-sm)] lg:order-1"
        aria-labelledby="recent-tasks-heading"
      >
        <div>
          <div className="px-5 pb-4 pt-5">
          <h2 id="recent-tasks-heading" className="text-[16px] font-semibold tracking-[-0.015em] text-text-primary">
            Continue
          </h2>
          <p className="mt-1 text-[12px] text-text-muted">Your work will stay within reach.</p>
          </div>

          <div className="flex min-h-[150px] items-center gap-4 border-t border-border-primary px-5 py-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-secondary text-text-muted">
              <MessageSquare size={17} strokeWidth={2} aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold text-text-primary">Your first task will show up here</h3>
              <p className="mt-1 max-w-[520px] text-[11.5px] leading-relaxed text-text-muted">
                Start with the composer or one of the ideas nearby, then return here whenever you want to continue.
              </p>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section
      className="order-2 w-full overflow-hidden rounded-[20px] border border-border-primary bg-bg-card shadow-[var(--shadow-sm)] lg:order-1"
      aria-labelledby="recent-tasks-heading"
    >
      <div>
        <div className="flex items-end justify-between gap-4 px-5 pb-4 pt-5">
          <div>
            <h2 id="recent-tasks-heading" className="text-[16px] font-semibold tracking-[-0.015em] text-text-primary">
              Continue
            </h2>
            <p className="mt-1 text-[12px] text-text-muted">Pick up where you left off.</p>
          </div>

          {allConversations.length > 4 && (
            <span className="shrink-0 text-[10.5px] tabular-nums text-text-muted">
              Latest 4 of {allConversations.length}
            </span>
          )}
        </div>

        <div className="border-t border-border-primary">
          {conversations.map((conv) => {
            const lastMsg = [...conv.messages]
              .reverse()
              .find((message) => stripMarkdown(message.content).length > 0)
            const preview = lastMsg ? stripMarkdown(lastMsg.content).slice(0, 120) : ''
            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => router.push(`/chat/${conv.id}`)}
                className="group flex min-h-[76px] w-full items-center gap-3.5 border-b border-border-secondary px-5 py-3.5 text-left transition-colors duration-[var(--dur-base)] ease-[var(--ease-out-expo)] last:border-b-0 hover:bg-bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-blue/35"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-secondary text-text-muted transition-colors group-hover:text-text-primary">
                  <MessageSquare size={14} strokeWidth={2} aria-hidden />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {conv.starred && (
                      <>
                        <Star
                          size={11}
                          strokeWidth={2.4}
                          className="shrink-0 fill-text-secondary text-text-secondary"
                          aria-hidden
                        />
                        <span className="sr-only">Starred</span>
                      </>
                    )}
                    <span className="block min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">
                      {conv.title}
                    </span>
                  </span>

                  <span className="mt-0.5 block truncate text-[11px] leading-relaxed text-text-muted">
                    {preview || 'No activity yet'}
                  </span>
                </span>

                <span className="w-[64px] shrink-0 text-right">
                  <time
                    dateTime={new Date(conv.updatedAt).toISOString()}
                    className="block text-[10.5px] font-medium tabular-nums text-text-tertiary"
                  >
                    {getRelativeTime(conv.updatedAt)}
                  </time>
                </span>

                <ChevronRight
                  size={13}
                  strokeWidth={2}
                  className="shrink-0 text-text-muted opacity-50 transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-out-expo)] group-hover:translate-x-0.5 group-hover:opacity-100"
                  aria-hidden
                />
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
