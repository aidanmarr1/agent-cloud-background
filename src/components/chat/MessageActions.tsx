'use client'

import { useState, useRef, useEffect } from 'react'
import { Copy, Check, RefreshCw, Pin } from '@/components/icons'

interface MessageActionsProps {
  variant: 'user' | 'assistant'
  onCopy: () => void
  onRegenerate?: () => void
  onPin?: () => void
  isPinned?: boolean
}

export function MessageActions({ variant, onCopy, onRegenerate, onPin, isPinned }: MessageActionsProps) {
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  const handleCopy = () => {
    onCopy()
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="absolute -top-10 right-0 opacity-0 group-hover:opacity-100 transition-all duration-200 flex items-center gap-0.5 menu-surface border border-border-primary rounded-xl p-1"
      style={{ boxShadow: 'var(--shadow-md)' }}
    >
      <button
        onClick={handleCopy}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
        title="Copy"
        aria-label={copied ? 'Copied' : 'Copy message'}
      >
        {copied ? (
          <Check size={14} className="text-text-secondary" strokeWidth={2.5} />
        ) : (
          <Copy size={14} />
        )}
      </button>
      {variant === 'assistant' && onRegenerate && (
        <button
          onClick={onRegenerate}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
          title="Regenerate"
          aria-label="Regenerate response"
        >
          <RefreshCw size={14} />
        </button>
      )}
      {onPin && (
        <button
          onClick={onPin}
          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150 ${
            isPinned
              ? 'text-text-secondary bg-bg-secondary'
              : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
          }`}
          title={isPinned ? 'Unpin' : 'Pin'}
          aria-label={isPinned ? 'Unpin message' : 'Pin message'}
        >
          <Pin
            size={14}
            fill={isPinned ? 'currentColor' : 'none'}
          />
        </button>
      )}
    </div>
  )
}
