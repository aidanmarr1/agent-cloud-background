'use client'

import { Globe, Play } from '@/components/icons'
import { BrowserResult } from '@/types'
import { isBrowserPreflightBlockText } from '@/lib/stream/constants'

interface BrowserViewProps {
  result: BrowserResult
  streaming?: boolean
  conversationId?: string
  isLatest?: boolean
  onJumpToLive?: () => void
}

function isBlockedBrowserAction(error?: string, action?: string): boolean {
  const combined = `${action || ''}\n${error || ''}`
  return isBrowserPreflightBlockText(combined)
}

function isPageLevelBrowserError(error?: string, action?: string): boolean {
  if (!error?.trim()) return false
  if (isBlockedBrowserAction(error, action)) return false
  if (/(?:INTERNAL_RECOVERY|FINAL_STEP_REDIRECT)/i.test(error)) return false
  return true
}

function visibleBrowserError(error: string, action?: string): string | null {
  if (!error.trim()) return null
  if (/(?:INTERNAL_RECOVERY|FINAL_STEP_REDIRECT)/i.test(error)) {
    return 'The agent skipped an unnecessary browser step and kept working.'
  }
  if (isBlockedBrowserAction(error, action)) {
    return null
  }
  if (/locator\.|Call log:|selectOption:|Timeout\s+\d+ms exceeded/i.test(error)) {
    return 'The browser action could not complete.'
  }
  if (/Navigation failed:\s*(?:HTTP\s*(?:4\d\d|5\d\d)|URL redirected|Page title|Page body)|ERROR PAGE DETECTED|Do NOT click elements on this error page|Do NOT retry this same URL/i.test(error)) {
    return 'This page could not be opened.'
  }
  return 'The browser action could not complete.'
}

function visibleBrowserContent(content: string): string {
  return content
    .replace(/^\s*INTERNAL_RECOVERY:[\s\S]*?(?=\n\n)/i, '')
    .replace(/^\s*(?:BROWSER_ACTION_PREFLIGHT_BLOCKED:\s*)?(?:Click|Action|Browser action|Repeated no-progress target|No live browser page|Index \[\d+\]|Element \[\d+\]|Selector "[^"]+"|browser_(?:click_at|type|select|fill_form))[\s\S]*?(?:fresh (?:\[N\] )?(?:elements )?list|blocked before execution|requires [^{]*\{index: N\}|Use browser_|Do not reuse an index)[\s\S]*?(?=\n\n|$)/i, '')
    .replace(/⚠\s*ERROR PAGE DETECTED[\s\S]*?Use the recovery options in the tool content\.?/gi, '')
    .trim()
}

function visibleBrowserAction(action: string | undefined): string {
  if (!action) return 'Browser'
  if (isBlockedBrowserAction(undefined, action)) return 'Browser state refreshed'
  return action
}

export function BrowserView({ result, streaming, conversationId, isLatest, onJumpToLive }: BrowserViewProps) {
  const safeResult: BrowserResult = result && typeof result === 'object'
    ? {
        success: result.success !== false,
        url: typeof result.url === 'string' ? result.url : '',
        title: typeof result.title === 'string' ? result.title : '',
        recoverable: result.recoverable,
        screenshotPath: typeof result.screenshotPath === 'string' ? result.screenshotPath : undefined,
        screenshotUrl: typeof result.screenshotUrl === 'string' ? result.screenshotUrl : undefined,
        screenshotBase64: typeof result.screenshotBase64 === 'string' ? result.screenshotBase64 : undefined,
        liveFrame: !!result.liveFrame,
        liveFrameUpdatedAt: typeof result.liveFrameUpdatedAt === 'number' ? result.liveFrameUpdatedAt : undefined,
        content: typeof result.content === 'string' ? result.content : undefined,
        error: typeof result.error === 'string' ? result.error : undefined,
        visualQuality: result.visualQuality,
        action: typeof result.action === 'string' ? result.action : 'Browser',
      }
    : { success: true, url: '', title: '', action: 'Browser' }
  const hasInlineFrame = !!safeResult.screenshotBase64
  const hasInlineLiveFrame = hasInlineFrame && !!safeResult.liveFrame
  const isLive = hasInlineLiveFrame
  const isWaitingForLiveFrame = !!conversationId && streaming && !hasInlineFrame
  const fallbackScreenshot = hasInlineFrame
    ? `data:image/jpeg;base64,${safeResult.screenshotBase64}`
    : safeResult.screenshotUrl || ''
  const hasCurrentLiveEvidence = hasInlineLiveFrame
  const hasPageError = !hasCurrentLiveEvidence && safeResult.success === false && isPageLevelBrowserError(safeResult.error, safeResult.action)
  const errorText = safeResult.error && hasPageError ? visibleBrowserError(safeResult.error, safeResult.action) : null
  const isActionBlocked = isBlockedBrowserAction(safeResult.error, safeResult.action)

  // Status line text
  const statusText = streaming
    ? `Browsing ${safeResult.url || '...'}`
    : visibleBrowserAction(safeResult.action)

  return (
    <div className="flex flex-col h-full">
      {/* Status line */}
      <div className="px-4 h-9 flex items-center gap-2 border-b border-border-primary flex-shrink-0">
        <Globe size={12} className={isLive ? 'text-text-secondary flex-shrink-0' : 'text-accent-blue flex-shrink-0'} strokeWidth={2.25} />
        <span className="text-[11.5px] text-text-muted truncate">
          Browser · {statusText}
        </span>
      </div>

      {/* URL bar */}
      <div className="mx-3 mt-3 bg-bg-secondary border border-border-primary rounded-xl px-3 h-8 flex items-center gap-2 flex-shrink-0">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
          hasPageError ? 'bg-accent-red/60' : isLive ? 'bg-text-secondary' : isWaitingForLiveFrame ? 'bg-text-muted animate-pulse' : 'bg-bg-secondary'
        }`} />
        <span className="text-[11px] text-text-muted truncate font-mono flex-1">{safeResult.url || 'Loading…'}</span>
        {isLive && (
          <span className="text-[10px] font-semibold text-text-secondary flex items-center gap-1 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-text-secondary animate-pulse" />
            Live
          </span>
        )}
        {isWaitingForLiveFrame && (
          <span className="text-[10px] text-text-muted [font-family:var(--font-display)] animate-pulse flex-shrink-0">Starting live view</span>
        )}
      </div>

      {/* Error */}
      {errorText && (
        <div className={`mx-3 mt-2 rounded-xl px-3 py-2 border ${
          isActionBlocked
            ? 'bg-bg-secondary border-border-primary'
            : 'bg-accent-red/5 border-accent-red/20'
        }`}>
          <p className={`text-[12px] ${isActionBlocked ? 'text-text-secondary' : 'text-accent-red'}`}>{errorText}</p>
        </div>
      )}

      {/* Browser viewport */}
      <div className="flex-1 mx-3 mt-2 mb-3 relative min-h-0">
        {fallbackScreenshot ? (
          <img
            src={fallbackScreenshot}
            alt={isLive ? 'Live browser view' : safeResult.title || 'Page screenshot'}
            className="w-full rounded-xl border border-border-primary object-contain"
          />
        ) : streaming ? (
          <div>
            <div className="w-full aspect-video bg-bg-secondary rounded-xl animate-pulse" />
            <div className="text-center text-[12px] text-text-muted [font-family:var(--font-display)] animate-pulse mt-3">
              {safeResult.action || 'Loading…'}
            </div>
          </div>
        ) : null}

        {/* "Jump to live" overlay */}
        {!isLatest && conversationId && onJumpToLive && (
          <button
            onClick={onJumpToLive}
            className="absolute bottom-3 right-3 menu-surface border border-border-primary rounded-lg px-3 h-8 flex items-center gap-1.5 hover:bg-bg-secondary transition-all duration-150"
            style={{ boxShadow: 'var(--shadow-md)' }}
          >
            <Play size={11} className="text-text-secondary" strokeWidth={2.5} />
            <span className="text-[11.5px] font-semibold text-text-primary">Jump to live</span>
          </button>
        )}
      </div>

      {/* Page title & content below viewport */}
      {(safeResult.title || safeResult.content) && (
        <div className="px-3 pb-3 flex-shrink-0">
          {safeResult.title && (
            <h2 className="text-[13px] font-semibold text-text-primary tracking-[0] mb-1.5">{safeResult.title}</h2>
          )}
          {safeResult.content && visibleBrowserContent(safeResult.content) && (
            <details>
              <summary className="text-[11.5px] text-text-muted hover:text-text-tertiary cursor-pointer transition-colors">
                Page text
              </summary>
              <div className="bg-bg-secondary border border-border-primary rounded-xl p-3 mt-2 max-h-[220px] overflow-y-auto">
                <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-words leading-relaxed">
                  {visibleBrowserContent(safeResult.content)}
                </pre>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
