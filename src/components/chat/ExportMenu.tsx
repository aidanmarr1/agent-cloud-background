'use client'

import { useState, useRef, useEffect } from 'react'
import { Download, FileText, Code } from '@/components/icons'
import type { Conversation } from '@/types'
import { exportAsMarkdown, exportAsJSON, downloadFile } from '@/lib/exportConversation'

interface ExportMenuProps {
  conversation: Conversation
}

export function ExportMenu({ conversation }: ExportMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const slug = conversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)

  const handleExportMarkdown = () => {
    const md = exportAsMarkdown(conversation)
    downloadFile(md, `${slug}.md`, 'text/markdown')
    setOpen(false)
  }

  const handleExportJSON = () => {
    const json = exportAsJSON(conversation)
    downloadFile(json, `${slug}.json`, 'application/json')
    setOpen(false)
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
        title="Export task"
        aria-label="Export task"
        aria-expanded={open}
      >
        <Download size={15} strokeWidth={2.25} />
      </button>

      {open && (
        <div
          className="absolute top-full right-0 mt-2 menu-surface border border-border-primary rounded-2xl overflow-hidden z-50 w-[220px] p-1.5 animate-scale-in"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          <div className="px-2.5 pt-1.5 pb-1">
            <span className="text-[11.5px] text-text-tertiary [font-family:var(--font-display)]">Export as</span>
          </div>
          <button
            type="button"
            onClick={handleExportMarkdown}
            className="w-full flex items-center gap-3 px-2.5 py-2 text-left rounded-lg hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150 group/item"
          >
            <div className="w-7 h-7 rounded-md bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
              <FileText size={13} className="text-text-tertiary group-hover/item:text-text-primary transition-colors" strokeWidth={2.25} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-text-primary tracking-[0]">Markdown</div>
              <div className="text-[10.5px] text-text-muted">.md file</div>
            </div>
          </button>
          <button
            type="button"
            onClick={handleExportJSON}
            className="w-full flex items-center gap-3 px-2.5 py-2 text-left rounded-lg hover:bg-bg-hover focus-visible:bg-bg-hover transition-all duration-150 group/item"
          >
            <div className="w-7 h-7 rounded-md bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
              <Code size={13} className="text-text-tertiary group-hover/item:text-text-primary transition-colors" strokeWidth={2.25} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-text-primary tracking-[0]">JSON</div>
              <div className="text-[10.5px] text-text-muted">.json file</div>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
