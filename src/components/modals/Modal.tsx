'use client'

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@/components/icons'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  wide?: boolean
  panelClassName?: string
}

export function Modal({ open, onClose, title, children, wide, panelClassName }: ModalProps) {
  useEffect(() => {
    if (!open) return

    const previousOverflow = document.body.style.overflow
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleEsc)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[180] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={`relative bg-bg-primary border border-border-primary rounded-2xl w-[95vw] ${
          panelClassName || (wide ? 'max-w-[720px] h-[540px] max-h-[85vh]' : 'max-w-[460px] max-h-[85vh]')
        } overflow-hidden flex flex-col`}
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)', boxShadow: 'var(--shadow-xl)' }}
      >
        {title && (
          <div className="flex items-center justify-between px-6 h-14 border-b border-border-primary flex-shrink-0">
            <h2 className="text-[16px] font-semibold text-text-primary tracking-[0]">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35 transition-colors duration-150"
            >
              <X size={14} strokeWidth={2.25} />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  )
}
