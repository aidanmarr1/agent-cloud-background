'use client'

import { useUIStore } from '@/store/ui'
import { ComputerPanelItem } from '@/types'
import { PanelHeader } from './PanelHeader'
import { SearchResults } from './SearchResults'
import { ImageSearchResults } from './ImageSearchResults'
import { BrowseView } from './BrowseView'
import { BrowserView } from './BrowserView'
import { SearchResult, BrowseResult, TerminalResult, FileResult, ImageSearchPanelItem, BrowserResult } from '@/types'
import { TerminalView } from './TerminalView'
import dynamic from 'next/dynamic'
import { useState, useEffect, useRef, useCallback, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react'

// Lazy-loaded — WebIdeView pulls in highlight.js language packs (~30KB gz) that
// are only needed when the user actively switches to the web IDE. Keeping it
// out of the initial chat bundle speeds up first paint for the common flow.
const WebIdeView = dynamic(
  () => import('./webide/WebIdeView').then((m) => ({ default: m.WebIdeView })),
  { ssr: false }
)
import { Search, Globe, Terminal, FileText, ImageIcon, Monitor, ChevronLeft, ChevronRight, SkipBack, SkipForward, Code2 } from '@/components/icons'

function isVisualBrowserPayload(data: unknown): data is BrowserResult {
  return !!data &&
    typeof data === 'object' &&
    ('screenshotBase64' in data || 'screenshotUrl' in data || 'screenshotPath' in data) &&
    'url' in data
}

function isViewportResizePanelItem(item: ComputerPanelItem): boolean {
  const data = item.data
  if (!data || typeof data !== 'object') return false
  const action = typeof (data as BrowserResult).action === 'string' ? (data as BrowserResult).action : ''
  const title = typeof item.title === 'string' ? item.title : ''
  return /\b(?:resize|viewport)\b/i.test(action) || /^Testing \d+x\d+$/i.test(action) || /^Testing \d+x\d+$/i.test(title)
}

function isLivePanelItem(item: ComputerPanelItem): boolean {
  if (item.streaming) return true
  if (item.type !== 'browser') return false
  const data = item.data as BrowserResult | undefined
  return !!data?.liveFrame
}

function FilePreview({ result, streaming, conversationId }: { result: FileResult; streaming?: boolean; conversationId?: string }) {
  const fileName = result.path?.split('/').pop() || 'file'
  const fileContentRef = useRef<HTMLDivElement>(null)
  const fileUrl = conversationId && result.path
    ? `/api/sandbox/${conversationId}/${result.path.split('/').map(encodeURIComponent).join('/')}`
    : null

  useEffect(() => {
    if (streaming && fileContentRef.current) {
      fileContentRef.current.scrollTop = fileContentRef.current.scrollHeight
    }
  }, [streaming, result.content])

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="bg-bg-secondary rounded-2xl border border-border-primary px-4 h-11 flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md bg-bg-primary border border-border-primary flex items-center justify-center flex-shrink-0">
          <FileText size={11} className="text-accent-blue" strokeWidth={2.25} />
        </div>
        <span className="text-[12.5px] text-text-primary font-mono truncate flex-1">{fileName}</span>
        {streaming && (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-status-live animate-pulse" />
            <span className="text-[10.5px] text-accent-blue font-semibold">writing</span>
          </span>
        )}
        {fileUrl && !streaming && (
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-accent-blue font-semibold hover:text-text-primary transition-colors flex-shrink-0"
          >
            Open
          </a>
        )}
      </div>
      {result.content && (
        <div ref={fileContentRef} className="bg-bg-primary rounded-2xl px-4 py-3.5 max-h-[500px] overflow-y-auto border border-border-primary">
          <pre className="text-[11.5px] text-text-secondary font-mono whitespace-pre-wrap break-words leading-relaxed">
            {result.content}
            {streaming && <span className="inline-block w-1.5 h-3 bg-text-muted animate-pulse ml-0.5 align-middle" />}
          </pre>
        </div>
      )}
      {result.files && result.files.length > 0 && (
        <div className="bg-bg-primary rounded-2xl px-4 py-3.5 border border-border-primary space-y-1">
          {result.files.map((f, i) => (
            <div key={i} className="text-[11.5px] text-text-secondary font-mono leading-relaxed">{f}</div>
          ))}
        </div>
      )}
      {result.size !== undefined && !streaming && (
        <span className="text-[11px] text-text-muted tabular-nums px-1.5 font-medium">
          {result.size.toLocaleString()} bytes
        </span>
      )}
    </div>
  )
}

interface ComputerPanelProps {
  items: ComputerPanelItem[]
  conversationId?: string
}

export function ComputerPanel({ items, conversationId }: ComputerPanelProps) {
  const computerPanelOpen = useUIStore((s) => s.computerPanelOpen)
  const computerActiveTab = useUIStore((s) => s.computerActiveTab)
  const computerPanelActiveItemId = useUIStore((s) => s.computerPanelActiveItemId)
  const setComputerActiveTab = useUIStore((s) => s.setComputerActiveTab)
  const setComputerPanelActiveItemId = useUIStore((s) => s.setComputerPanelActiveItemId)
  const webIdeMode = useUIStore((s) => s.webIdeMode)
  const webIdeEntryFile = useUIStore((s) => s.webIdeEntryFile)
  const computerPanelWidth = useUIStore((s) => s.computerPanelWidth)
  const setComputerPanelWidth = useUIStore((s) => s.setComputerPanelWidth)
  const [activeIndex, setActiveIndex] = useState(0)
  const [filterType, setFilterType] = useState<'all' | 'search' | 'browse' | 'terminal' | 'file' | 'image_search' | 'browser'>('all')
  const contentRef = useRef<HTMLDivElement>(null)
  const visibleItems = items.filter((item) => !isViewportResizePanelItem(item))

  const filteredItems = filterType === 'all' ? visibleItems : visibleItems.filter((i) => i.type === filterType)
  const safeIndex = Math.min(activeIndex, Math.max(0, filteredItems.length - 1))
  const activeItem = filteredItems.length > 0 ? filteredItems[safeIndex] : null

  const lastItem = visibleItems[visibleItems.length - 1]
  const lastItemFingerprint = lastItem ? `${lastItem.id}_${lastItem.streaming}_${lastItem.type}` : null

  // Auto-jump to the most relevant item whenever items change.
  // Always follow the newest item to avoid jumping back to stale streaming
  // items (e.g. file_content_delta re-setting streaming:true on old file items).
  useEffect(() => {
    if (visibleItems.length === 0) return

    if (computerPanelActiveItemId) {
      const focusedIndex = visibleItems.findIndex((item) => item.id === computerPanelActiveItemId)
      if (focusedIndex >= 0) {
        setFilterType('all')
        setActiveIndex(focusedIndex)
        return
      }
    }

    if (filterType === 'all') {
      // Always show the newest item — this ensures the panel tracks
      // the latest action instead of jumping back to stale streaming items
      setActiveIndex(visibleItems.length - 1)
    } else {
      // In filtered view: check if agent switched to a different action type
      const latestItem = visibleItems[visibleItems.length - 1]
      const filtered = visibleItems.filter((i) => i.type === filterType)

      if (latestItem && latestItem.streaming && latestItem.type !== filterType) {
        // Agent switched to a different action type — follow it
        const newType = latestItem.type as typeof filterType
        setFilterType(newType)
        const newFiltered = visibleItems.filter((i) => i.type === newType)
        setActiveIndex(newFiltered.length - 1)
      } else {
        // Show latest in current filter
        setActiveIndex(filtered.length - 1)
      }
    }
  }, [visibleItems.length, lastItemFingerprint, computerPanelActiveItemId]) // eslint-disable-line react-hooks/exhaustive-deps

  const isAtLatest = safeIndex === filteredItems.length - 1
  const liveIndex = filteredItems.reduce((latest, item, idx) => isLivePanelItem(item) ? idx : latest, -1)
  const hasLiveItem = liveIndex >= 0
  const activeItemIsLive = !!activeItem && isLivePanelItem(activeItem)
  const jumpToLive = useCallback(() => {
    setComputerPanelActiveItemId(null)
    setActiveIndex(hasLiveItem ? liveIndex : filteredItems.length - 1)
  }, [filteredItems.length, hasLiveItem, liveIndex, setComputerPanelActiveItemId])

  // Resize handle
  const isDragging = useRef(false)
  const handlePointerDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault()
    isDragging.current = true
    const onMove = (ev: globalThis.PointerEvent) => {
      const newWidth = ((window.innerWidth - ev.clientX) / window.innerWidth) * 100
      setComputerPanelWidth(Math.min(70, Math.max(20, newWidth)))
    }
    const onUp = () => {
      isDragging.current = false
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [setComputerPanelWidth])

  // Swipe-to-dismiss on mobile
  const touchStartY = useRef<number | null>(null)
  const handleTouchStart = useCallback((e: ReactTouchEvent) => {
    touchStartY.current = e.touches[0].clientY
  }, [])
  const handleTouchEnd = useCallback((e: ReactTouchEvent) => {
    if (touchStartY.current !== null) {
      const deltaY = e.changedTouches[0].clientY - touchStartY.current
      if (deltaY > 100) {
        useUIStore.getState().setComputerPanelOpen(false, { source: 'user' })
      }
      touchStartY.current = null
    }
  }, [])

  // Auto-scroll content area when active item is streaming
  useEffect(() => {
    if (activeItem?.streaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [activeItem?.streaming, activeItem])

  if (!computerPanelOpen) return null
  if (!webIdeMode && visibleItems.length === 0) return null

  const searchCount = visibleItems.filter((i) => i.type === 'search').length
  const imageSearchCount = visibleItems.filter((i) => i.type === 'image_search').length
  const browseCount = visibleItems.filter((i) => i.type === 'browse').length
  const terminalCount = visibleItems.filter((i) => i.type === 'terminal').length
  const fileCount = visibleItems.filter((i) => i.type === 'file').length
  const browserCount = visibleItems.filter((i) => i.type === 'browser').length

  return (
    <>
      {/* Mobile backdrop */}
      <button
        type="button"
        className="fixed inset-0 bg-[var(--overlay-scrim)] z-[125] md:hidden cursor-default"
        onClick={() => useUIStore.getState().setComputerPanelOpen(false, { source: 'user' })}
        aria-label="Close computer panel"
      />

      {/* Desktop width via CSS custom prop */}
      <style>{`
        @media (min-width: 768px) {
          [data-computer-panel] {
            width: calc(${computerPanelWidth}% - 24px);
          }
        }
      `}</style>

      <div
        data-computer-panel=""
        className="fixed bg-bg-primary border border-border-primary flex flex-col animate-panel-in z-[130] overflow-hidden inset-0 h-[100dvh] rounded-none md:inset-auto md:right-2 md:top-2 md:bottom-2 md:h-auto md:rounded-2xl md:z-30"
        style={{ boxShadow: 'var(--shadow-lg)' }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Resize handle — left edge */}
        <div
          className="hidden md:block absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-50 hover:bg-bg-secondary transition-colors"
          onPointerDown={handlePointerDown}
        />
        <PanelHeader />

        {webIdeMode && (
          <div className="h-10 px-2 flex items-center gap-1 border-b border-border-primary flex-shrink-0 overflow-x-auto scrollbar-none sm:px-3">
            <button
              onClick={() => setComputerActiveTab('activity')}
              className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${
                computerActiveTab === 'activity'
                  ? 'bg-bg-secondary text-accent-blue'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
              }`}
            >
              <Monitor size={12} strokeWidth={2.25} />
              Activity
              <span className="tabular-nums opacity-70">{visibleItems.length}</span>
            </button>
            <button
              onClick={() => setComputerActiveTab('webide')}
              className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 min-w-0 ${
                computerActiveTab === 'webide'
                  ? 'bg-bg-secondary text-accent-blue'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
              }`}
            >
              <Code2 size={12} strokeWidth={2.25} />
              <span className="flex-shrink-0">Editor</span>
              {webIdeEntryFile && (
                <span className="hidden lg:inline text-[10.5px] font-mono opacity-70 truncate max-w-[120px]">
                  {webIdeEntryFile.split('/').pop()}
                </span>
              )}
            </button>
          </div>
        )}

        {webIdeMode && computerActiveTab === 'webide' ? (
          <WebIdeView />
        ) : (
          <>
            {/* Tab buttons */}
            <div className="h-10 px-2 flex items-center gap-1 border-b border-border-primary flex-shrink-0 overflow-x-auto scrollbar-none sm:px-3">
              {(() => {
                const tc = (type: string) =>
                  filterType === type
                    ? 'bg-bg-secondary text-accent-blue'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                return (
                  <>
                    <button
                      onClick={() => { setComputerPanelActiveItemId(null); setFilterType('all'); setActiveIndex(visibleItems.length - 1) }}
                      className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${tc('all')}`}
                    >
                      All
                      <span className="tabular-nums opacity-70">{visibleItems.length}</span>
                    </button>
                    <button
                      onClick={() => { setComputerPanelActiveItemId(null); setFilterType('search'); setActiveIndex(Math.max(0, searchCount - 1)) }}
                      className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${tc('search')}`}
                    >
                      <Search size={12} />
                      <span className="tabular-nums">{searchCount}</span>
                    </button>
                    {imageSearchCount > 0 && (
                      <button
                        onClick={() => { setComputerPanelActiveItemId(null); setFilterType('image_search'); setActiveIndex(Math.max(0, imageSearchCount - 1)) }}
                        className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${tc('image_search')}`}
                      >
                        <ImageIcon size={12} />
                        <span className="tabular-nums">{imageSearchCount}</span>
                      </button>
                    )}
                    <button
                      onClick={() => { setComputerPanelActiveItemId(null); setFilterType('browse'); setActiveIndex(Math.max(0, browseCount - 1)) }}
                      className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${tc('browse')}`}
                    >
                      <Globe size={12} />
                      <span className="tabular-nums">{browseCount}</span>
                    </button>
                    <button
                      onClick={() => { setComputerPanelActiveItemId(null); setFilterType('terminal'); setActiveIndex(Math.max(0, terminalCount - 1)) }}
                      className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${tc('terminal')}`}
                    >
                      <Terminal size={12} />
                      <span className="tabular-nums">{terminalCount}</span>
                    </button>
                    {fileCount > 0 && (
                      <button
                        onClick={() => { setComputerPanelActiveItemId(null); setFilterType('file'); setActiveIndex(Math.max(0, fileCount - 1)) }}
                        className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${tc('file')}`}
                      >
                        <FileText size={12} />
                        <span className="tabular-nums">{fileCount}</span>
                      </button>
                    )}
                    {browserCount > 0 && (
                      <button
                        onClick={() => { setComputerPanelActiveItemId(null); setFilterType('browser'); setActiveIndex(Math.max(0, browserCount - 1)) }}
                        className={`flex flex-shrink-0 items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-2 h-8 rounded-md transition-all duration-150 ${tc('browser')}`}
                      >
                        <Monitor size={12} />
                        <span className="tabular-nums">{browserCount}</span>
                      </button>
                    )}
                  </>
                )
              })()}
            </div>

            {/* Content */}
            <div ref={contentRef} className="flex-1 overflow-y-auto overflow-x-hidden">
              {activeItem ? (activeItem.type === 'image_search' ? (
                <ImageSearchResults results={activeItem.data as ImageSearchPanelItem[]} streaming={activeItem.streaming} title={activeItem.title} />
              ) : activeItem.type === 'search' ? (
                <SearchResults results={activeItem.data as SearchResult[]} streaming={activeItem.streaming} title={activeItem.title} />
              ) : activeItem.type === 'terminal' ? (
                <TerminalView result={activeItem.data as TerminalResult} streaming={activeItem.streaming} />
              ) : activeItem.type === 'file' ? (
                <FilePreview result={activeItem.data as FileResult} streaming={activeItem.streaming} conversationId={conversationId} />
              ) : activeItem.type === 'browser' || isVisualBrowserPayload(activeItem.data) ? (
                <BrowserView result={activeItem.data as BrowserResult} streaming={activeItem.streaming} conversationId={activeItem.id === 'browser_live' ? conversationId : undefined} isLatest={isAtLatest} onJumpToLive={jumpToLive} />
              ) : (
                <BrowseView result={activeItem.data as BrowseResult} streaming={activeItem.streaming} />
              )) : (
                <div className="flex-1 flex items-center justify-center h-full py-16 px-6">
                  <span className="text-[13px] text-text-tertiary [font-family:var(--font-display)] text-center">
                    {filterType === 'all' ? 'No activity yet' : `No ${{
                      search: 'search results',
                      browse: 'pages',
                      terminal: 'commands',
                      file: 'files',
                      image_search: 'images',
                      browser: 'browser views',
                    }[filterType]} yet`}
                  </span>
                </div>
              )}
            </div>

            {/* Timeline */}
            {filteredItems.length > 0 && (
              <div className="h-11 border-t border-border-primary flex items-center px-2 gap-1 flex-shrink-0 sm:px-3 sm:gap-2">
                <button
                  onClick={() => { setComputerPanelActiveItemId(null); setActiveIndex(0) }}
                  className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted transition-all duration-150"
                  disabled={safeIndex === 0}
                  aria-label="First item"
                >
                  <SkipBack size={13} strokeWidth={2.25} />
                </button>
                <button
                  onClick={() => { setComputerPanelActiveItemId(null); setActiveIndex(Math.max(0, safeIndex - 1)) }}
                  className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted transition-all duration-150"
                  disabled={safeIndex === 0}
                  aria-label="Previous item"
                >
                  <ChevronLeft size={15} strokeWidth={2.25} />
                </button>
                <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full relative overflow-hidden mx-1">
                  <div
                    className="h-full bg-text-secondary rounded-full transition-all duration-300"
                    style={{
                      width: `${((safeIndex + 1) / filteredItems.length) * 100}%`,
                    }}
                  />
                </div>
                <button
                  onClick={() => { setComputerPanelActiveItemId(null); setActiveIndex(Math.min(filteredItems.length - 1, safeIndex + 1)) }}
                  className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted transition-all duration-150"
                  disabled={isAtLatest}
                  aria-label="Next item"
                >
                  <ChevronRight size={15} strokeWidth={2.25} />
                </button>
                <button
                  onClick={jumpToLive}
                  className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted transition-all duration-150"
                  disabled={isAtLatest}
                  aria-label="Last item"
                >
                  <SkipForward size={13} strokeWidth={2.25} />
                </button>
                {activeItemIsLive ? (
                  <span className="text-[11px] text-text-secondary font-semibold flex items-center gap-1.5 ml-1.5 min-w-[44px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-text-secondary animate-pulse" />
                    live
                  </span>
                ) : hasLiveItem ? (
                  <button
                    type="button"
                    onClick={jumpToLive}
                    className="text-[11px] text-text-secondary font-semibold flex items-center justify-end gap-1.5 ml-1.5 min-w-[68px] tabular-nums hover:text-text-primary transition-colors"
                    aria-label="Jump to live activity"
                  >
                    <span className="text-text-muted">{safeIndex + 1}/{filteredItems.length}</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-text-secondary animate-pulse" />
                    <span>live</span>
                  </button>
                ) : (
                  <span className="text-[11px] text-text-secondary font-semibold tabular-nums ml-1.5 min-w-[44px] text-right">
                    {safeIndex + 1} / {filteredItems.length}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
