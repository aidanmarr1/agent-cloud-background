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
    <div className="message-actions absolute -top-8 right-0 z-20 flex items-center gap-0.5 transition-opacity duration-100">
      <button
        type="button"
        onClick={handleCopy}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors duration-100 hover:bg-bg-secondary hover:text-text-primary"
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
          type="button"
          onClick={onRegenerate}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors duration-100 hover:bg-bg-secondary hover:text-text-primary"
          title="Regenerate"
          aria-label="Regenerate response"
        >
          <RefreshCw size={14} />
        </button>
      )}
      {onPin && (
        <button
          type="button"
          onClick={onPin}
          className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-100 ${
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
