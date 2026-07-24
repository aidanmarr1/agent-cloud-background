'use client'

import { useState, useEffect, useRef } from 'react'
import { Brain, ChevronDown } from '@/components/icons'

interface ThinkingViewProps {
  reasoning?: string
  isStreaming: boolean
  hasContent: boolean
}

export function ThinkingView({ reasoning, isStreaming, hasContent }: ThinkingViewProps) {
  const [expanded, setExpanded] = useState(() => isStreaming && !hasContent)
  const [autoCollapsed, setAutoCollapsed] = useState(() => hasContent || !isStreaming)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom while streaming
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [reasoning, expanded])

  // Auto-collapse 400ms after content starts arriving
  useEffect(() => {
    if (hasContent && !autoCollapsed) {
      const timer = setTimeout(() => {
        setExpanded(false)
        setAutoCollapsed(true)
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [hasContent, autoCollapsed])

  if (!reasoning) return null

  const isActive = isStreaming && !hasContent
  const lineCount = reasoning.split('\n').filter(Boolean).length

  return (
    <div className={isActive ? 'mb-4' : 'mt-4'}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex min-h-8 w-fit max-w-full items-center gap-2.5 py-1.5 text-left"
        aria-expanded={expanded}
        aria-label={isActive ? 'Thinking in progress, click to collapse' : 'Show reasoning'}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <Brain
            size={14}
            className={`transition-colors ${isActive ? 'text-accent-blue' : 'text-text-muted'}`}
            strokeWidth={2}
            style={isActive ? { animation: 'pulse-dot 2s ease-in-out infinite' } : undefined}
          />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[12px] font-medium [font-family:var(--font-display)] ${isActive ? 'text-text-secondary' : 'text-text-muted'}`}>
          {isActive ? 'Thinking through the request…' : 'Reasoning'}
        </span>
        {!isActive && <span className="text-[10px] tabular-nums text-text-muted">{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>}
        <ChevronDown
          size={11}
          className={`flex-shrink-0 text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-out-expo)] ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="min-h-0 overflow-hidden">
          <div
            ref={scrollRef}
            className="ml-[9px] max-h-[280px] overflow-y-auto border-l border-border-secondary px-4 py-2"
          >
            <div className="whitespace-pre-line break-words font-mono text-[11.5px] leading-[1.65] text-text-tertiary">
              {reasoning}
              {isActive && (
                <span className="ml-1 inline-block h-[13px] w-[2px] rounded-sm bg-text-muted align-middle" style={{ animation: 'thinkingBlink 1.2s ease-in-out infinite' }} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
