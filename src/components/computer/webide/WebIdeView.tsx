'use client'

import { useUIStore } from '@/store/ui'
import { Play, Code2, RefreshCw } from '@/components/icons'
import { WebIdePreview } from './WebIdePreview'
import { WebIdeCodePanel } from './WebIdeCodePanel'

export function WebIdeView() {
  const webIdeActiveTab = useUIStore((s) => s.webIdeActiveTab)
  const webIdeEntryFile = useUIStore((s) => s.webIdeEntryFile)
  const setWebIdeActiveTab = useUIStore((s) => s.setWebIdeActiveTab)
  const incrementWebIdeRefresh = useUIStore((s) => s.incrementWebIdeRefresh)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab bar */}
      <div className="h-11 px-3 flex items-center gap-1 border-b border-border-primary">
        <button
          onClick={() => setWebIdeActiveTab('preview')}
          className={`flex items-center gap-1.5 text-[12px] font-medium px-2.5 h-8 rounded-md transition-all duration-150 ${
            webIdeActiveTab === 'preview' ? 'bg-bg-secondary text-accent-blue' : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
          }`}
        >
          <Play size={11} strokeWidth={2.25} />
          Preview
        </button>
        <button
          onClick={() => setWebIdeActiveTab('code')}
          className={`flex items-center gap-1.5 text-[12px] font-medium px-2.5 h-8 rounded-md transition-all duration-150 ${
            webIdeActiveTab === 'code' ? 'bg-bg-secondary text-accent-blue' : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
          }`}
        >
          <Code2 size={11} strokeWidth={2.25} />
          Code
        </button>

        <div className="flex-1" />

        {webIdeEntryFile && (
          <span className="text-[11px] text-text-muted font-mono truncate max-w-[140px]">{webIdeEntryFile}</span>
        )}

        <div className="w-px h-5 bg-border-secondary mx-1" />

        <button
          onClick={incrementWebIdeRefresh}
          className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
          title="Refresh preview"
          aria-label="Refresh preview"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {webIdeActiveTab === 'preview' ? <WebIdePreview /> : <WebIdeCodePanel />}
      </div>
    </div>
  )
}
