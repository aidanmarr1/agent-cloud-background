'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, X, ChevronUp, ChevronDown } from '@/components/icons'
import type { Message } from '@/types'

interface Match {
  messageId: string
  index: number
}

interface ConversationSearchProps {
  messages: Message[]
  onClose: () => void
  onScrollToMessage: (messageId: string) => void
}

export function ConversationSearch({ messages, onClose, onScrollToMessage }: ConversationSearchProps) {
  const [query, setQuery] = useState('')
  const [currentMatch, setCurrentMatch] = useState(0)

  // Stash the callback in a ref so the auto-scroll effect doesn't re-fire
  // every time the parent re-renders (e.g. on every streaming token).
  const onScrollRef = useRef(onScrollToMessage)
  useEffect(() => {
    onScrollRef.current = onScrollToMessage
  })

  const matches = useMemo(() => {
    if (!query.trim()) return []
    const lowerQuery = query.toLowerCase()
    const found: Match[] = []
    for (const msg of messages) {
      const lowerContent = msg.content.toLowerCase()
      let startIdx = 0
      let pos = lowerContent.indexOf(lowerQuery, startIdx)
      while (pos !== -1) {
        found.push({ messageId: msg.id, index: pos })
        startIdx = pos + lowerQuery.length
        pos = lowerContent.indexOf(lowerQuery, startIdx)
      }
    }
    return found
  }, [messages, query])

  useEffect(() => {
    setCurrentMatch(0)
  }, [query])

  // Only re-scroll when the *target message* changes, not when the matches
  // array gets a new reference (which happens on every streaming token because
  // `messages` is recomputed upstream).
  const targetMessageId = matches[currentMatch]?.messageId
  useEffect(() => {
    if (targetMessageId) {
      onScrollRef.current(targetMessageId)
    }
  }, [targetMessageId])

  const goNext = useCallback(() => {
    if (matches.length === 0) return
    setCurrentMatch((prev) => (prev + 1) % matches.length)
  }, [matches.length])

  const goPrev = useCallback(() => {
    if (matches.length === 0) return
    setCurrentMatch((prev) => (prev - 1 + matches.length) % matches.length)
  }, [matches.length])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) {
          goPrev()
        } else {
          goNext()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, goNext, goPrev])

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 animate-fade-in">
      <div
        className="flex items-center gap-2 bg-bg-card border border-border-primary rounded-2xl pl-3.5 pr-1.5 h-11 min-w-[360px]"
        style={{ boxShadow: 'var(--shadow-lg)' }}
      >
        <Search size={14} className="text-text-muted flex-shrink-0" strokeWidth={2.25} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search in task…"
          className="flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-muted/80 placeholder:[font-family:var(--font-display)] outline-none"
        />
        {query.trim() && (
          <span className="text-[11px] text-text-muted whitespace-nowrap flex-shrink-0 tabular-nums font-medium">
            {matches.length > 0
              ? `${currentMatch + 1} / ${matches.length}`
              : 'No matches'}
          </span>
        )}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={goPrev}
            disabled={matches.length === 0}
            className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150"
            aria-label="Previous match"
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={matches.length === 0}
            className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150"
            aria-label="Next match"
          >
            <ChevronDown size={13} />
          </button>
        </div>
        <div className="w-px h-5 bg-border-secondary mx-0.5" />
        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
          aria-label="Close task search"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
