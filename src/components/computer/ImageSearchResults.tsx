'use client'

import { ImageSearchPanelItem } from '@/types'
import { ImageIcon } from '@/components/icons'

interface ImageSearchResultsProps {
  results: ImageSearchPanelItem[]
  streaming?: boolean
  title?: string
}

function getSafeHttpUrl(url?: string | null): string | null {
  const trimmed = (url || '').trim()
  if (!trimmed || trimmed.startsWith('//')) return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function getSafeImageSrc(url?: string | null): string | null {
  const trimmed = (url || '').trim()
  if (!trimmed || trimmed.startsWith('//')) return null
  if (trimmed.startsWith('/')) return trimmed
  return getSafeHttpUrl(trimmed)
}

function visibleImageSearchTitle(title?: string): string {
  const trimmed = (title || '').trim()
  if (!trimmed || /^(?:Image Search|Image lookup in progress)$/i.test(trimmed)) return ''
  return trimmed
}

function ImageSearchContextHeader({ title, count, streaming }: { title?: string; count: number; streaming?: boolean }) {
  const label = visibleImageSearchTitle(title)
  if (!label) return null

  return (
    <div className="px-3 pt-3 pb-2 border-b border-border-primary bg-bg-primary">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] font-semibold text-text-primary truncate [font-family:var(--font-display)] tracking-[0]">
          {label}
        </p>
        <span className="text-[10.5px] text-text-muted tabular-nums flex-shrink-0">
          {streaming ? 'running' : `${count} image${count === 1 ? '' : 's'}`}
        </span>
      </div>
    </div>
  )
}

export function ImageSearchResults({ results, streaming, title }: ImageSearchResultsProps) {
  const items = Array.isArray(results) ? results : []

  if (items.length === 0 && streaming) {
    return (
      <>
        <ImageSearchContextHeader title={title} count={items.length} streaming={streaming} />
        <div className="p-4 grid grid-cols-2 gap-2.5">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="aspect-square bg-bg-secondary rounded-2xl animate-pulse" />
          ))}
          <div className="col-span-2 text-center text-[12px] text-text-muted [font-family:var(--font-display)] animate-pulse mt-1">
            Searching images...
          </div>
        </div>
      </>
    )
  }

  if (items.length === 0) {
    return (
      <>
        <ImageSearchContextHeader title={title} count={items.length} streaming={streaming} />
        <div className="flex-1 flex flex-col items-center justify-center h-full py-16">
          <div className="w-12 h-12 rounded-2xl bg-bg-secondary border border-border-primary flex items-center justify-center mb-4">
            <ImageIcon size={18} className="text-text-tertiary" strokeWidth={1.75} />
          </div>
          <p className="text-[14px] text-text-primary [font-family:var(--font-display)]">No images found</p>
        </div>
      </>
    )
  }

  return (
    <div className="overflow-y-auto">
      <ImageSearchContextHeader title={title} count={items.length} streaming={streaming} />
      <div className="p-4 grid grid-cols-2 gap-2.5">
        {items.map((item, i) => {
        const sourceUrl = getSafeHttpUrl(item.sourceUrl)
        const primarySrc = getSafeImageSrc(item.localUrl || item.thumbnailUrl)
        const fallbackSrc = getSafeImageSrc(item.thumbnailUrl)
        const className = 'group relative aspect-square rounded-2xl overflow-hidden bg-bg-tertiary border border-border-primary hover:border-border-tertiary transition-all duration-150'
        const content = (
          <>
            {primarySrc && (
              <img
                src={primarySrc}
                alt={item.title}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
                onError={(e) => {
                  const target = e.target as HTMLImageElement
                  if (fallbackSrc && target.src !== fallbackSrc) {
                    target.src = fallbackSrc
                  } else {
                    target.style.display = 'none'
                    const parent = target.parentElement
                    if (parent) {
                      const placeholder = parent.querySelector('.img-placeholder')
                      if (placeholder) (placeholder as HTMLElement).style.display = 'flex'
                    }
                  }
                }}
              />
            )}
            <div className={`${primarySrc ? 'hidden' : 'flex'} img-placeholder items-center justify-center absolute inset-0`}>
              <ImageIcon size={22} className="text-text-muted" />
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-[var(--overlay-caption)] px-2.5 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <p className="text-[10.5px] text-text-on-accent truncate font-medium">{item.title}</p>
            </div>
          </>
        )

        if (!sourceUrl) {
          return (
            <div key={i} className={className}>
              {content}
            </div>
          )
        }

        return (
          <a
            key={i}
            href={sourceUrl}
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
