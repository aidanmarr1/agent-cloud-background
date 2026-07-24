'use client'

import type { KeyboardEvent, MouseEvent } from 'react'
import { Download } from '@/components/icons'
import { FileBadge } from '@/components/ui/FileBadge'
import { formatBytes, getFileExtension } from '@/lib/fileHandling'
import { useUIStore } from '@/store/ui'
import type { Artifact } from '@/types'

interface DocumentPreviewProps {
  artifact: Artifact
  conversationId?: string
}

export function DocumentPreview({ artifact, conversationId }: DocumentPreviewProps) {
  const openProjectFiles = useUIStore((state) => state.openProjectFiles)
  const canOpen = Boolean(conversationId && artifact.filePath)

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

  const extension = getFileExtension(artifact.fileName)
  const typeLabel = extension === 'md' || extension === 'markdown'
    ? 'Markdown'
    : extension === 'txt'
      ? 'Text'
      : extension
        ? extension.toUpperCase()
        : 'Document'
  const fileSize = formatBytes(new TextEncoder().encode(artifact.content).byteLength)

  return (
    <div className="document-preview !mt-0 mb-2 inline-block w-full max-w-[360px] align-top animate-fade-in sm:w-[calc(50%-0.375rem)] sm:[&:nth-child(odd)]:mr-3">
      <div
        role="button"
        tabIndex={canOpen ? 0 : -1}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
        aria-label={`Open ${artifact.fileName} in project files`}
        aria-disabled={!canOpen}
        className={`group flex h-[68px] w-full items-center gap-2.5 rounded-xl border border-border-primary bg-bg-secondary px-3 text-left transition-colors duration-100 ${
          canOpen
            ? 'cursor-pointer hover:border-border-tertiary hover:bg-bg-tertiary'
            : 'cursor-default'
        }`}
      >
        <FileBadge name={artifact.fileName} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold tracking-[0] text-text-primary">
            {artifact.fileName}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] font-medium tabular-nums text-text-muted">
            {typeLabel} · {fileSize}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          aria-label={`Download ${artifact.fileName}`}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-text-muted opacity-100 transition-[background-color,color,opacity] duration-100 hover:bg-bg-primary hover:text-text-primary sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          <Download size={13} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  )
}
