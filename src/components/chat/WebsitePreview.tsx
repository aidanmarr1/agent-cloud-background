'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Download, ExternalLink, FileCode, Globe, MoreHorizontal } from '@/components/icons'
import { Modal } from '@/components/modals/Modal'
import type { Artifact } from '@/types'

interface WebsitePreviewProps {
  artifact: Artifact
  conversationId?: string
}

function downloadUrl(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.click()
}

export function WebsitePreview({ artifact, conversationId }: WebsitePreviewProps) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const urls = useMemo(() => {
    if (!conversationId || !artifact.filePath) return null
    const fileParams = new URLSearchParams({
      conversationId,
      file: artifact.filePath,
      inline: '1',
    })
    const downloadParams = new URLSearchParams({
      conversationId,
      file: artifact.filePath,
      download: '1',
    })
    const archiveParams = new URLSearchParams({
      conversationId,
      file: artifact.filePath,
    })
    return {
      preview: `/api/files?${fileParams.toString()}`,
      download: `/api/files?${downloadParams.toString()}`,
      archive: `/api/files/website-archive?${archiveParams.toString()}`,
    }
  }, [artifact.filePath, conversationId])

  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    return () => document.removeEventListener('pointerdown', closeMenu)
  }, [menuOpen])

  const toggleMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setMenuOpen(open => !open)
  }

  return (
    <>
      <div className="relative w-full max-w-[520px] animate-fade-in" ref={menuRef}>
        <button
          type="button"
          onClick={() => urls && setPreviewOpen(true)}
          disabled={!urls}
          aria-label={`Preview website ${artifact.fileName}`}
          className="group block w-full overflow-hidden rounded-2xl border border-border-primary bg-bg-secondary text-left transition-colors duration-150 hover:border-border-tertiary disabled:cursor-default"
        >
          <div className="relative h-[210px] overflow-hidden border-b border-border-primary bg-white">
            {urls ? (
              <iframe
                src={urls.preview}
                title={`Preview of ${artifact.fileName}`}
                className="pointer-events-none h-[420px] w-[200%] origin-top-left scale-50 border-0"
                sandbox="allow-scripts allow-forms allow-modals allow-popups"
                tabIndex={-1}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-text-muted">
                <Globe size={24} strokeWidth={1.7} />
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 h-10 bg-bg-secondary/90" />
          </div>
          <div className="flex h-[68px] items-center gap-3 px-4">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-border-primary bg-bg-primary text-accent-blue">
              <Globe size={16} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-text-primary">{artifact.fileName}</div>
              <div className="mt-0.5 text-[10.5px] font-medium text-text-muted">Website · Click to preview</div>
            </div>
            <ExternalLink size={14} className="text-text-muted transition-colors group-hover:text-text-primary" />
          </div>
        </button>

        <button
          type="button"
          onClick={toggleMenu}
          disabled={!urls}
          aria-label={`Website options for ${artifact.fileName}`}
          aria-expanded={menuOpen}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated text-text-secondary shadow-sm transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:hidden"
        >
          <MoreHorizontal size={15} strokeWidth={2.2} />
        </button>

        {menuOpen && urls && (
          <div className="absolute right-3 top-12 z-20 w-52 rounded-xl border border-border-primary bg-bg-elevated p-1.5 shadow-xl">
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setPreviewOpen(true) }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              <ExternalLink size={13} />
              Open website preview
            </button>
            <button
              type="button"
              onClick={() => { setMenuOpen(false); downloadUrl(urls.archive) }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              <FileCode size={13} />
              Download source ZIP
            </button>
            <button
              type="button"
              onClick={() => { setMenuOpen(false); downloadUrl(urls.download) }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              <Download size={13} />
              Download bundled HTML
            </button>
          </div>
        )}
      </div>

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={artifact.fileName}
        panelClassName="max-w-[1180px] h-[88vh]"
      >
        <div className="h-full bg-white">
          {urls && (
            <iframe
              src={urls.preview}
              title={artifact.fileName}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
            />
          )}
        </div>
      </Modal>
    </>
  )
}
