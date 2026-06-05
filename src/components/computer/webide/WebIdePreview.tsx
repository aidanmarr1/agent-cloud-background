'use client'

import { useUIStore } from '@/store/ui'
import { Globe, RefreshCw, ExternalLink, Monitor, Tablet, Smartphone } from '@/components/icons'

const viewportWidths = {
  desktop: '100%',
  tablet: '768px',
  mobile: '375px',
} as const

function sandboxFileUrl(conversationId: string, filePath: string): string {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `/api/sandbox/${conversationId}/${encodedPath}`
}

function withCacheBuster(url: string, key: number): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}ide_v=${key}`
}

function isNextPageEntry(filePath: string): boolean {
  return /(^|\/)(?:src\/)?app\/page\.tsx$/i.test(filePath)
}

export function WebIdePreview() {
  const webIdeConversationId = useUIStore((s) => s.webIdeConversationId)
  const webIdeEntryFile = useUIStore((s) => s.webIdeEntryFile)
  const webIdePreviewUrl = useUIStore((s) => s.webIdePreviewUrl)
  const webIdeRefreshKey = useUIStore((s) => s.webIdeRefreshKey)
  const incrementWebIdeRefresh = useUIStore((s) => s.incrementWebIdeRefresh)
  const webIdeViewport = useUIStore((s) => s.webIdeViewport)
  const setWebIdeViewport = useUIStore((s) => s.setWebIdeViewport)

  if (!webIdeConversationId || !webIdeEntryFile) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-12 h-12 rounded-2xl bg-bg-secondary border border-border-primary flex items-center justify-center mb-4">
          <Globe size={18} className="text-text-tertiary" strokeWidth={1.75} />
        </div>
        <p className="text-[14px] text-text-primary [font-family:var(--font-display)]">No preview available</p>
      </div>
    )
  }

  const nextPreview = isNextPageEntry(webIdeEntryFile)
  const previewBaseUrl = webIdePreviewUrl || sandboxFileUrl(webIdeConversationId, webIdeEntryFile)
  const src = withCacheBuster(previewBaseUrl, webIdeRefreshKey)
  const entryFileDisplay = webIdeEntryFile.split('/').pop() || webIdeEntryFile
  const isReady = nextPreview ? Boolean(webIdePreviewUrl) : webIdeRefreshKey > 0

  return (
    <div className="flex flex-col h-full">
      {/* URL bar + viewport toggle */}
      <div className="px-3 py-2.5 space-y-2">
        <div className="bg-bg-secondary border border-border-primary rounded-xl px-3 h-8 flex items-center gap-2">
          <Globe size={12} className="text-text-muted flex-shrink-0" strokeWidth={2.25} />
          <span className="text-[11.5px] text-text-secondary font-mono truncate flex-1">{entryFileDisplay}</span>
          <button
            onClick={incrementWebIdeRefresh}
            className="w-6 h-6 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150 disabled:opacity-30"
            title="Refresh"
            aria-label="Refresh preview"
            disabled={!isReady}
          >
            <RefreshCw size={11} />
          </button>
          {isReady && (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="w-6 h-6 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
              title="Open in new tab"
            >
              <ExternalLink size={11} />
            </a>
          )}
        </div>

        {/* Viewport toggle */}
        <div className="flex items-center justify-center gap-0.5 p-1 bg-bg-secondary border border-border-primary rounded-lg w-fit mx-auto">
          {([
            { key: 'desktop' as const, icon: Monitor, label: 'Desktop' },
            { key: 'tablet' as const, icon: Tablet, label: 'Tablet (768px)' },
            { key: 'mobile' as const, icon: Smartphone, label: 'Mobile (375px)' },
          ]).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setWebIdeViewport(key)}
              className={`w-7 h-7 rounded-md flex items-center justify-center transition-all duration-150 ${
                webIdeViewport === key
                  ? 'bg-bg-secondary text-accent-blue'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
              }`}
              title={label}
              aria-label={label}
            >
              <Icon size={13} strokeWidth={2.25} />
            </button>
          ))}
        </div>
      </div>

      {/* iframe or loading placeholder */}
      <div className="flex-1 min-h-0 flex justify-center px-3 pb-3">
        <div
          className="h-full transition-all duration-200"
          style={{ width: viewportWidths[webIdeViewport], maxWidth: '100%' }}
        >
          {isReady ? (
            <iframe
              key={webIdeRefreshKey}
              src={src}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="w-full h-full border border-border-primary bg-preview-canvas rounded-xl"
              title="Website Preview"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-bg-secondary border border-border-primary rounded-xl">
              <div className="text-center space-y-3">
                <div className="w-5 h-5 border-2 border-text-muted/20 border-t-accent-blue rounded-full animate-spin mx-auto" />
                <p className="text-[12px] text-text-muted [font-family:var(--font-display)]">Building preview…</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
