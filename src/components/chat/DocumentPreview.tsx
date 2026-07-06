'use client'

import type { KeyboardEvent, MouseEvent } from 'react'
import { Download } from '@/components/icons'
import { FileBadge } from '@/components/ui/FileBadge'
import { useUIStore } from '@/store/ui'
import type { Artifact } from '@/types'

interface DocumentPreviewProps {
  artifact: Artifact
  conversationId?: string
}

export function DocumentPreview({ artifact, conversationId }: DocumentPreviewProps) {
  const openProjectFiles = useUIStore((state) => state.openProjectFiles)

  const handleOpen = () => {
    if (conversationId && artifact.filePath) {
      openProjectFiles(conversationId, artifact.filePath)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    handleOpen()
  }

  const handleDownload = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const blob = new Blob([artifact.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = artifact.fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  const title = artifact.fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())

  const date = new Date(artifact.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="document-preview max-w-[760px] animate-fade-in rounded-2xl">
      <div
        role="button"
        tabIndex={conversationId && artifact.filePath ? 0 : -1}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
        aria-label={`Open ${artifact.fileName} in project files`}
        aria-disabled={!conversationId || !artifact.filePath}
        className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-border-primary bg-bg-secondary px-3 py-3 text-left transition-colors duration-150 hover:border-border-tertiary hover:bg-bg-tertiary aria-disabled:cursor-default aria-disabled:hover:border-border-primary aria-disabled:hover:bg-bg-secondary"
      >
        <FileBadge name={artifact.fileName} />
        <div className="flex-1 min-w-0">
          <div className="truncate text-[13.5px] font-semibold tracking-[0] text-text-primary">
            {title}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] font-medium text-text-tertiary tabular-nums">
            {date} · {(artifact.content.length / 1024).toFixed(1)} KB
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          aria-label={`Download ${artifact.fileName}`}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-muted opacity-100 transition-colors duration-150 hover:bg-bg-primary hover:text-text-primary sm:opacity-0 sm:group-hover:opacity-100"
        >
          <Download size={14} strokeWidth={2.35} />
        </button>
      </div>
    </div>
  )
}
