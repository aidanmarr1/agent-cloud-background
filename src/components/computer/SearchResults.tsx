'use client'

import { SearchResult } from '@/types'

interface SearchResultsProps {
  results: SearchResult[]
  streaming?: boolean
  title?: string
}

function getFaviconUrl(url: string): string | null {
  try {
    const safeUrl = getSafeHttpUrl(url)
    if (!safeUrl) return null
    const hostname = new URL(safeUrl).hostname
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`
  } catch {
    return null
  }
}

function getSafeHttpUrl(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed.startsWith('//')) return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function visibleSearchTitle(title?: string): string {
  const trimmed = (title || '').trim()
  if (!trimmed || /^(?:Search Results|Search in progress)$/i.test(trimmed)) return ''
  return trimmed
}

function SearchContextHeader({ title, count, streaming }: { title?: string; count: number; streaming?: boolean }) {
  const label = visibleSearchTitle(title)
  if (!label) return null

  return (
    <div className="px-3 pt-3 pb-2 border-b border-border-primary bg-bg-primary">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] font-semibold text-text-primary truncate [font-family:var(--font-display)] tracking-[0]">
          {label}
        </p>
        <span className="text-[10.5px] text-text-muted tabular-nums flex-shrink-0">
          {streaming ? 'running' : `${count} result${count === 1 ? '' : 's'}`}
        </span>
      </div>
    </div>
  )
}

export function SearchResults({ results, streaming, title }: SearchResultsProps) {
  const items = Array.isArray(results) ? results : []

  // Search execution issues are handled by the agent loop. Keep provider
  // hiccups out of the Computer panel so the workspace does not look broken.
  if (!Array.isArray(results) && results && typeof results === 'object' && 'error' in results) {
    return null
  }

  if (items.length === 0 && streaming) {
    return (
      <>
        <SearchContextHeader title={title} count={items.length} streaming={streaming} />
        <div className="p-3 space-y-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3 py-3 px-3 rounded-xl border border-border-primary bg-bg-secondary">
              <div className="w-8 h-8 rounded-lg bg-bg-tertiary border border-border-primary flex-shrink-0 animate-pulse" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 bg-bg-tertiary rounded-md animate-pulse w-3/4" />
                <div className="h-2 bg-bg-tertiary rounded-md animate-pulse w-1/3" />
                <div className="h-2 bg-bg-tertiary rounded-md animate-pulse w-full" />
              </div>
            </div>
          ))}
          <div className="text-center text-[12px] text-text-tertiary [font-family:var(--font-display)] animate-pulse pt-3">
            Searching...
          </div>
        </div>
      </>
    )
  }

  if (items.length === 0) {
    return (
      <>
        <SearchContextHeader title={title} count={items.length} streaming={streaming} />
        <div className="flex items-center justify-center h-full py-16 px-6">
          <p className="text-[13px] text-text-tertiary [font-family:var(--font-display)] text-center">
            No results found
          </p>
        </div>
      </>
    )
  }

  return (
    <div className="overflow-hidden">
      <SearchContextHeader title={title} count={items.length} streaming={streaming} />
      <div className="p-2 space-y-0.5 w-full">
        {items.map((result, i) => {
          const safeUrl = getSafeHttpUrl(result.url)
          const favicon = safeUrl ? getFaviconUrl(safeUrl) : null
          let hostname = ''
          try { hostname = safeUrl ? new URL(safeUrl).hostname.replace(/^www\./, '') : '' } catch {}
          const content = (
            <>
              {favicon ? (
                <div className="w-8 h-8 rounded-lg bg-bg-secondary flex items-center justify-center flex-shrink-0 mt-0.5 overflow-hidden border border-border-primary">
                  <img
                    src={favicon}
                    alt=""
                    width={16}
                    height={16}
                    className="rounded-sm"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                </div>
              ) : (
                <div className="w-8 h-8 rounded-lg bg-bg-secondary flex-shrink-0 mt-0.5 border border-border-primary" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-text-primary group-hover:text-accent-blue truncate transition-colors duration-150 tracking-[0]">
                  {result.title}
                </div>
                <div className="text-[11px] text-text-muted truncate mt-0.5">
                  {hostname || result.url}
                </div>
                {result.snippet && (
                  <p className="text-[12px] text-text-tertiary line-clamp-2 mt-1.5 leading-relaxed">
                    {result.snippet}
                  </p>
                )}
              </div>
            </>
          )
          const className = 'group flex items-start gap-3 py-3 px-3 rounded-xl hover:bg-bg-secondary transition-all duration-200 border border-transparent hover:border-border-primary'
          if (!safeUrl) {
            return (
              <div key={i} className={className}>
                {content}
              </div>
            )
          }
          return (
            <a
              key={i}
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
            >
              {content}
            </a>
          )
        })}
      </div>
    </div>
  )
}
