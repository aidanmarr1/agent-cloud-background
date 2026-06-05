'use client'

import { useState } from 'react'
import { Modal } from '@/components/modals/Modal'
import { Download, Code, FileText, Image as ImageIcon, LayoutGrid } from '@/components/icons'
import type { Artifact } from '@/types'

interface ArtifactGalleryProps {
  open: boolean
  onClose: () => void
  artifacts: Artifact[]
}

type FilterTab = 'all' | 'code' | 'document' | 'image'

function filterLabel(tab: FilterTab): string {
  if (tab === 'all') return 'All'
  if (tab === 'document') return 'Docs'
  return tab[0].toUpperCase() + tab.slice(1)
}

export function ArtifactGallery({ open, onClose, artifacts }: ArtifactGalleryProps) {
  const [filter, setFilter] = useState<FilterTab>('all')

  const filtered = filter === 'all' ? artifacts : artifacts.filter(a => a.type === filter)

  const getIcon = (type: Artifact['type']) => {
    switch (type) {
      case 'code': return Code
      case 'document': return FileText
      case 'image': return ImageIcon
      default: return FileText
    }
  }

  const handleDownload = (artifact: Artifact) => {
    if (artifact.type === 'image' && (artifact.imageDataUrl || artifact.imageUrl)) {
      const a = document.createElement('a')
      a.href = artifact.imageDataUrl || artifact.imageUrl || ''
      a.download = artifact.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      return
    }

    const blob = new Blob([artifact.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = artifact.fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <Modal open={open} onClose={onClose} title="Files" wide>
      <div className="space-y-5 p-5">
        {/* Filter tabs */}
        <div className="flex gap-1 bg-bg-secondary border border-border-primary rounded-xl p-1 w-fit">
          {(['all', 'code', 'document', 'image'] as FilterTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-all duration-150 capitalize ${
                filter === tab
                  ? 'bg-bg-primary text-text-primary border border-border-primary'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {tab === 'all' ? (
                <span className="flex items-center gap-1.5">
                  {filterLabel(tab)}
                  <span className="tabular-nums text-text-muted/70">{artifacts.length}</span>
                </span>
              ) : filterLabel(tab)}
            </button>
          ))}
        </div>

        {/* Grid */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-12 h-12 rounded-2xl bg-bg-secondary border border-border-primary flex items-center justify-center mb-4">
              <LayoutGrid size={20} className="text-text-tertiary" strokeWidth={1.75} />
            </div>
            <p className="text-[15px] text-text-primary [font-family:var(--font-display)]">No files yet</p>
            <p className="text-[12px] text-text-tertiary mt-1">Generated files will show up here</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {filtered.map(artifact => {
              const Icon = getIcon(artifact.type)
              return (
                <div
                  key={artifact.id}
                  className="bg-bg-secondary border border-border-primary rounded-2xl p-4 hover:border-border-tertiary transition-all duration-150 group"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-9 h-9 rounded-xl bg-bg-tertiary border border-border-primary flex items-center justify-center">
                      <Icon size={15} className="text-text-tertiary" strokeWidth={2} />
                    </div>
                    <button
                      onClick={() => handleDownload(artifact)}
                      className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary opacity-0 group-hover:opacity-100 transition-all duration-150"
                    >
                      <Download size={12} />
                    </button>
                  </div>
                  <div className="text-[12.5px] font-semibold text-text-primary truncate tracking-[0]">{artifact.fileName}</div>
                  <div className="text-[10.5px] text-text-muted mt-1 tabular-nums capitalize">
                    {artifact.type} · {(artifact.content.length / 1024).toFixed(1)} KB
                  </div>
                  {artifact.type === 'code' && (
                    <pre className="mt-3 text-[10px] text-text-tertiary font-mono line-clamp-3 overflow-hidden leading-relaxed">
                      {artifact.content.slice(0, 200)}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
