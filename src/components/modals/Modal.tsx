'use client'

import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@/components/icons'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.closest('[aria-hidden="true"], [inert]')) return false
    return element.getClientRects().length > 0
  })
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  ariaLabel?: string
  children: React.ReactNode
  wide?: boolean
  panelClassName?: string
}

export function Modal({ open, onClose, title, ariaLabel, children, wide, panelClassName }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()

  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return

    const previousOverflow = document.body.style.overflow
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') return

      const focusableElements = panel ? getFocusableElements(panel) : []
      if (!panel || focusableElements.length === 0) {
        event.preventDefault()
        panel?.focus({ preventScroll: true })
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]
      const activeElement = document.activeElement

      if (event.shiftKey && (activeElement === firstElement || !panel.contains(activeElement))) {
        event.preventDefault()
        lastElement.focus({ preventScroll: true })
      } else if (!event.shiftKey && (activeElement === lastElement || !panel.contains(activeElement))) {
        event.preventDefault()
        firstElement.focus({ preventScroll: true })
      }
    }

    panel?.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'

    const focusFrame = window.requestAnimationFrame(() => {
      const initialFocus = panel?.querySelector<HTMLElement>('[data-autofocus], [autofocus]')
        || (panel ? getFocusableElements(panel)[0] : null)
        || panel
      initialFocus?.focus({ preventScroll: true })
    })

    return () => {
      window.cancelAnimationFrame(focusFrame)
      panel?.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[180] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-label="Close dialog"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || (!title ? 'Dialog' : undefined)}
        aria-labelledby={!ariaLabel && title ? titleId : undefined}
        tabIndex={-1}
        className={`relative bg-bg-elevated border border-border-primary rounded-2xl w-[95vw] ${
          panelClassName || (wide ? 'max-w-[720px] h-[540px] max-h-[85vh]' : 'max-w-[460px] max-h-[85vh]')
        } overflow-hidden flex flex-col`}
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)', boxShadow: 'var(--shadow-xl)' }}
      >
        {title && (
          <div className="flex items-center justify-between px-6 h-14 border-b border-border-primary flex-shrink-0">
            <h2 id={titleId} className="text-[16px] font-semibold text-text-primary tracking-[0]">{title}</h2>
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
