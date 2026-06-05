'use client'

import { useState, useEffect, useRef } from 'react'
import { Brain, ChevronDown } from '@/components/icons'

interface ThinkingViewProps {
  reasoning?: string
  isStreaming: boolean
  hasContent: boolean
}

export function ThinkingView({ reasoning, isStreaming, hasContent }: ThinkingViewProps) {
  const [expanded, setExpanded] = useState(true)
  const [autoCollapsed, setAutoCollapsed] = useState(false)
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

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 py-1.5 px-2.5 -mx-2 rounded-lg hover:bg-bg-secondary transition-all duration-150 group"
        aria-expanded={expanded}
        aria-label={isActive ? 'Thinking in progress, click to collapse' : 'Show reasoning'}
      >
        <Brain
          size={14}
          className={`flex-shrink-0 transition-colors ${isActive ? 'text-accent-blue' : 'text-text-muted'}`}
          strokeWidth={2}
          style={isActive ? { animation: 'pulse-dot 2s ease-in-out infinite' } : undefined}
        />
        <span className={`text-[13px] [font-family:var(--font-display)] ${isActive ? 'text-text-secondary' : 'text-text-muted'}`}>
          {isActive ? 'Thinking…' : 'Reasoning'}
        </span>
        {!isActive && reasoning && (
          <>
            <span className="w-1 h-1 rounded-full bg-text-muted/40" />
            <span className="text-[11px] text-text-muted/80 tabular-nums">
              {reasoning.split('\n').length} lines
            </span>
          </>
        )}
        <ChevronDown
          size={12}
          className={`text-text-muted transition-transform duration-200 ml-0.5 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <div
        className="overflow-hidden transition-all"
        style={{
          maxHeight: expanded ? 320 : 0,
          opacity: expanded ? 1 : 0,
          transitionDuration: '350ms',
          transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
          transitionProperty: 'max-height, opacity',
        }}
      >
        <div
          ref={scrollRef}
          className="mt-2 max-h-[300px] overflow-y-auto rounded-2xl bg-bg-secondary border border-border-primary px-4 py-3.5"
        >
          <div className="text-[12px] text-text-tertiary font-mono whitespace-pre-line leading-relaxed break-words">
            {reasoning}
            {isActive && (
              <span className="inline-block w-[6px] h-[14px] bg-bg-secondary ml-0.5 align-middle rounded-sm" style={{ animation: 'thinkingBlink 1.2s ease-in-out infinite' }} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
