'use client'

import { BrowseResult } from '@/types'

interface BrowseViewProps {
  result: BrowseResult
  streaming?: boolean
}

function splitIntoParagraphs(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

export function BrowseView({ result, streaming }: BrowseViewProps) {
  const displayContent = result.content?.trim() || 'No extracted text was returned for this source.'
  const paragraphs = splitIntoParagraphs(displayContent)

  let hostname = ''
  try { hostname = new URL(result.url).hostname.replace(/^www\./, '') } catch {}

  if (!result.content && streaming) {
    return (
      <div className="p-4">
        {/* URL bar */}
        <div className="h-10 px-3.5 mb-4 flex items-center gap-2.5 rounded-xl border border-border-primary bg-bg-secondary">
          <div className="w-1.5 h-1.5 rounded-full bg-status-live animate-pulse flex-shrink-0" />
          <span className="text-[11.5px] text-text-tertiary truncate font-mono">{hostname || result.url}</span>
        </div>
        <div className="space-y-2.5">
          <div className="h-5 bg-bg-tertiary rounded-md animate-pulse w-2/3" />
          <div className="h-3 bg-bg-tertiary rounded-md animate-pulse w-full" />
          <div className="h-3 bg-bg-tertiary rounded-md animate-pulse w-5/6" />
          <div className="h-3 bg-bg-tertiary rounded-md animate-pulse w-3/4" />
        </div>
        <div className="text-center text-[12px] text-text-tertiary [font-family:var(--font-display)] animate-pulse mt-5">
          Loading page…
        </div>
      </div>
    )
  }

  return (
    <div className="p-4">
      {/* URL bar */}
      <div className="h-10 px-3.5 mb-5 flex items-center gap-2.5 rounded-xl border border-border-primary bg-bg-secondary">
        <div className="w-1.5 h-1.5 rounded-full bg-text-secondary flex-shrink-0" />
        <span className="text-[11.5px] text-text-tertiary truncate font-mono">{hostname || result.url}</span>
      </div>

      {/* Page title */}
      <h2 className="text-[20px] text-text-primary mb-4 leading-tight tracking-[0] [font-family:var(--font-display)] font-semibold">
        {result.title}
      </h2>

      {/* Content */}
      <div className="text-[13px] text-text-secondary leading-relaxed space-y-3.5">
        {paragraphs.length > 1 ? (
          paragraphs.map((p, i) => <p key={i}>{p}</p>)
        ) : (
          <p>{displayContent}</p>
        )}
      </div>
    </div>
  )
}
