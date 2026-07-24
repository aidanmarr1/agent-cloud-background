'use client'

import { useState } from 'react'
import { ImageIcon, Download, Maximize2, X } from '@/components/icons'
import { Artifact } from '@/types'

interface ImagePreviewProps {
  artifact: Artifact
  compact?: boolean
}

export function ImagePreview({ artifact, compact = false }: ImagePreviewProps) {
  const [lightbox, setLightbox] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [loading, setLoading] = useState(true)

  const imageSrc = artifact.imageDataUrl || artifact.imageUrl
  const fileType = artifact.fileName.split('.').pop()?.toUpperCase() || 'Image'

  const handleDownload = () => {
    if (!imageSrc) return
    const a = document.createElement('a')
    a.href = imageSrc
    a.download = artifact.fileName
    a.click()
  }

  if (compact) {
    return (
      <>
        <div className="image-preview rounded-2xl border border-border-primary bg-bg-card animate-fade-in overflow-hidden">
          <div className="flex items-center gap-3 p-3">
            <button
              type="button"
              onClick={() => imageSrc && setLightbox(true)}
              className="relative w-14 h-14 rounded-xl bg-bg-secondary border border-border-primary flex items-center justify-center overflow-hidden flex-shrink-0"
              aria-label={`Preview ${artifact.fileName}`}
            >
              {loadError || !imageSrc ? (
                <ImageIcon size={18} className="text-text-tertiary" strokeWidth={2.1} />
              ) : (
                <>
                  {loading && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-4 h-4 border-2 border-border-primary border-t-text-muted rounded-full animate-spin" />
                    </div>
                  )}
                  <img
                    src={imageSrc}
                    alt={artifact.fileName}
                    className={`w-full h-full object-cover transition-opacity duration-150 ${loading ? 'opacity-0' : 'opacity-100'}`}
                    onLoad={() => setLoading(false)}
                    onError={() => { setLoadError(true); setLoading(false) }}
                  />
                </>
              )}
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px] font-semibold text-text-primary truncate tracking-[0] [font-family:var(--font-display)]">
                {artifact.fileName}
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">
                {fileType} image
              </div>
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                type="button"
                onClick={handleDownload}
                className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
                title="Download image"
                aria-label={`Download ${artifact.fileName}`}
              >
                <Download size={13} strokeWidth={2.25} />
              </button>
              <button
                type="button"
                onClick={() => setLightbox(true)}
                className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
                title="View fullscreen"
                aria-label={`Open ${artifact.fileName} fullscreen`}
                disabled={!imageSrc}
              >
                <Maximize2 size={13} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </div>

        {lightbox && imageSrc && (
          <div
            className="fixed inset-0 z-50 bg-[var(--overlay-scrim-strong)] flex items-center justify-center p-8 animate-fade-in"
            onKeyDown={(e) => { if (e.key === 'Escape') setLightbox(false) }}
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${artifact.fileName}`}
            tabIndex={-1}
          >
            <button
              type="button"
              className="absolute inset-0 z-0 cursor-default"
              onClick={() => setLightbox(false)}
              aria-label="Close image preview"
              tabIndex={-1}
            />
            <button
              type="button"
              onClick={() => setLightbox(false)}
              className="absolute top-4 right-4 z-20 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--overlay-caption)] text-text-on-scrim transition-colors duration-150 hover:bg-[var(--overlay-scrim)]"
              aria-label="Close preview"
            >
              <X size={18} strokeWidth={2.25} />
            </button>
            <img
              src={imageSrc}
              alt={artifact.fileName}
              className="relative z-10 max-w-full max-h-full object-contain rounded-xl"
            />
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <div className="image-preview rounded-2xl border border-border-primary overflow-hidden animate-fade-in bg-bg-card">
        {/* Header */}
        <div className="flex items-center gap-3 pl-3.5 pr-2 h-12 border-b border-border-primary">
          <div className="w-8 h-8 rounded-xl bg-bg-secondary flex items-center justify-center flex-shrink-0">
            <ImageIcon size={14} className="text-accent-blue" strokeWidth={2.25} />
          </div>
          <span className="text-[13.5px] font-semibold text-text-primary truncate flex-1 tracking-[0] [font-family:var(--font-display)]">
            {artifact.fileName}
          </span>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button
              type="button"
              onClick={handleDownload}
              className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
              title="Download image"
              aria-label={`Download ${artifact.fileName}`}
            >
              <Download size={13} strokeWidth={2.25} />
            </button>
            <button
              type="button"
              onClick={() => setLightbox(true)}
              className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
              title="View fullscreen"
              aria-label={`Open ${artifact.fileName} fullscreen`}
            >
              <Maximize2 size={13} strokeWidth={2.25} />
            </button>
          </div>
        </div>

        {/* Image */}
        <div className="px-4 py-4 bg-bg-secondary">
          {loadError ? (
            <div className="flex items-center justify-center h-40 text-text-muted text-[13px] [font-family:var(--font-display)]">
              Failed to load image
            </div>
          ) : (
            <div className="relative">
              {loading && (
                <div className="flex items-center justify-center h-40">
                  <div className="w-5 h-5 border-2 border-border-primary border-t-text-muted rounded-full animate-spin" />
                </div>
              )}
              {imageSrc && (
                <button
                  type="button"
                  onClick={() => setLightbox(true)}
                  className={`mx-auto max-w-full max-h-[400px] rounded-lg overflow-hidden ${loading ? 'hidden' : 'block'}`}
                  aria-label={`Open ${artifact.fileName} fullscreen`}
                >
                  <img
                    src={imageSrc}
                    alt={artifact.fileName}
                    className="max-w-full max-h-[400px] block"
                    onLoad={() => setLoading(false)}
                    onError={() => { setLoadError(true); setLoading(false) }}
                  />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox overlay */}
      {lightbox && imageSrc && (
        <div
          className="fixed inset-0 z-50 bg-[var(--overlay-scrim-strong)] flex items-center justify-center p-8 animate-fade-in"
          onKeyDown={(e) => { if (e.key === 'Escape') setLightbox(false) }}
          role="dialog"
          aria-modal="true"
          aria-label={`Image preview: ${artifact.fileName}`}
          tabIndex={-1}
        >
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-default"
            onClick={() => setLightbox(false)}
            aria-label="Close image preview"
            tabIndex={-1}
          />
          <button
            type="button"
            onClick={() => setLightbox(false)}
            className="absolute top-4 right-4 z-20 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--overlay-caption)] text-text-on-scrim transition-colors duration-150 hover:bg-[var(--overlay-scrim)]"
            aria-label="Close preview"
          >
            <X size={18} strokeWidth={2.25} />
          </button>
          <img
            src={imageSrc}
            alt={artifact.fileName}
            className="relative z-10 max-w-full max-h-full object-contain rounded-xl"
          />
        </div>
      )}
    </>
  )
}
