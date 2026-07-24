'use client'

import { useState } from 'react'
import { GitBranch, ChevronDown } from '@/components/icons'
import { useChatStore } from '@/store/chat'
import type { ConversationBranch } from '@/types'

interface BranchIndicatorProps {
  conversationId: string
  branches: ConversationBranch[]
}

export function BranchIndicator({ conversationId, branches }: BranchIndicatorProps) {
  const [open, setOpen] = useState(false)

  if (branches.length === 0) return null

  const switchBranch = (branch: ConversationBranch) => {
    useChatStore.setState((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        const idx = c.messages.findIndex(m => m.id === branch.parentMessageId)
        if (idx < 0) return c
        return {
          ...c,
          messages: [...c.messages.slice(0, idx + 1), ...branch.messages],
          updatedAt: Date.now(),
        }
      }),
    }))
    setOpen(false)
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 h-7 rounded-md text-[11px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
        aria-label="Show task branches"
        aria-expanded={open}
      >
        <GitBranch size={12} strokeWidth={2.25} />
        <span>{branches.length} branch{branches.length !== 1 ? 'es' : ''}</span>
        <ChevronDown size={10} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 menu-surface border border-border-primary rounded-2xl p-1.5 min-w-[220px] z-50 animate-scale-in" style={{ boxShadow: 'var(--shadow-menu)' }}>
          <div className="px-2.5 pt-1.5 pb-1">
            <span className="text-[11.5px] text-text-tertiary [font-family:var(--font-display)]">Branches</span>
          </div>
          {branches.map((branch) => (
            <button
              key={branch.id}
              type="button"
              onClick={() => switchBranch(branch)}
              className="w-full px-2.5 py-2 text-left rounded-lg hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150"
            >
              <div className="text-[12.5px] font-semibold text-text-primary truncate tracking-[0]">
                {branch.messages[0]?.content.slice(0, 50) || 'Branch'}
              </div>
              <div className="text-[10.5px] text-text-muted mt-0.5 tabular-nums">
                {branch.messages.length} turn{branch.messages.length !== 1 ? 's' : ''} · {new Date(branch.createdAt).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
