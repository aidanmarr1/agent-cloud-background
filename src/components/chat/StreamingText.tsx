'use client'

import { memo } from 'react'
import { MarkdownLite } from './MarkdownLite'

interface StreamingTextProps {
  content: string
}

export const StreamingText = memo(function StreamingText({ content }: StreamingTextProps) {
  return (
    <div className="markdown-content chat-reading-text text-text-primary">
      <MarkdownLite>{content}</MarkdownLite>
    </div>
  )
})
