'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from '@/components/icons'
import { CodeBlock } from './CodeBlock'

interface CollapsibleCodeBlockProps {
  children: React.ReactNode
  lineCount: number
}

const COLLAPSE_THRESHOLD = 50
const PREVIEW_LINES = 10

export function CollapsibleCodeBlock({ children, lineCount }: CollapsibleCodeBlockProps) {
  const [collapsed, setCollapsed] = useState(lineCount > COLLAPSE_THRESHOLD)

  if (lineCount <= COLLAPSE_THRESHOLD) {
    return <CodeBlock>{children}</CodeBlock>
  }

  return (
    <div className="relative">
      <div
        className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={{ maxHeight: collapsed ? `${PREVIEW_LINES * 1.6 * 13 + 80}px` : '100000px' }}
      >
        <CodeBlock>{children}</CodeBlock>
      </div>
      {collapsed && (
        <div className="absolute bottom-8 left-0 right-0 h-20 bg-bg-secondary backdrop-blur-sm border-t border-border-primary pointer-events-none" />
      )}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="relative z-10 w-full flex items-center justify-center gap-1.5 h-8 text-[11.5px] font-semibold text-accent-blue hover:bg-bg-secondary transition-all duration-150 border-t border-border-primary"
      >
        {collapsed ? (
          <>
            <ChevronDown size={12} strokeWidth={2.5} />
            Show more <span className="text-text-muted font-medium tabular-nums">· {lineCount} lines</span>
          </>
        ) : (
          <>
            <ChevronUp size={12} strokeWidth={2.5} />
            Show less
          </>
        )}
      </button>
    </div>
  )
}
