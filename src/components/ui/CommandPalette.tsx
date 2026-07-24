'use client'

import { useState, useEffect, useRef, useCallback, useId, useMemo } from 'react'
import {
  Search, MessageSquare, PenSquare, Settings, Keyboard,
} from '@/components/icons'
import { useChatStore } from '@/store/chat'
import { useUIStore } from '@/store/ui'
import { useRouter } from 'next/navigation'
import { Conversation } from '@/types'

interface PaletteItem {
  id: string
  type: 'task' | 'action'
  title: string
  subtitle: string
  icon: React.ReactNode
  onSelect: () => void
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.closest('[aria-hidden="true"], [inert]')) return false
    return element.getClientRects().length > 0
  })
}

function getPreview(conv: Conversation): string {
  const userMsg = conv.messages.find((m) => m.role === 'user')
  return userMsg?.content.slice(0, 60) || 'New task'
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const resultsId = useId()
  const optionIdPrefix = useId()
  const tasksGroupLabelId = useId()
  const actionsGroupLabelId = useId()
  const router = useRouter()

  // Register Cmd+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Reset the palette, move focus into it, and return focus to its opener.
  useEffect(() => {
    if (!open) return

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setSelectedIndex(0)

    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
    })

    return () => {
      window.cancelAnimationFrame(focusFrame)
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [open])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setSelectedIndex(0)
  }, [])

  const conversations = useChatStore((s) => s.conversations)

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = []

    // Task results
    let matchedConversations: Conversation[]
    if (query.trim()) {
      const ids = new Set(useChatStore.getState().searchConversations(query))
      matchedConversations = conversations.filter((c) => ids.has(c.id))
    } else {
      // Show 5 most recent
      matchedConversations = [...conversations]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
    }

    for (const conv of matchedConversations) {
      result.push({
        id: conv.id,
        type: 'task',
        title: conv.title,
        subtitle: getPreview(conv),
        icon: <MessageSquare size={14} className="text-text-muted" />,
        onSelect: () => {
          useChatStore.getState().setActiveId(conv.id)
          router.push(`/chat/${conv.id}`)
          close()
        },
      })
    }

    // Actions (always shown)
    result.push({
      id: 'action-new',
      type: 'action',
      title: 'New Task',
      subtitle: 'Start a fresh task',
      icon: <PenSquare size={14} className="text-text-muted" />,
      onSelect: () => {
        router.push('/')
        close()
      },
    })

    result.push({
      id: 'action-settings',
      type: 'action',
      title: 'Settings',
      subtitle: 'Open application settings',
      icon: <Settings size={14} className="text-text-muted" />,
      onSelect: () => {
        const ui = useUIStore.getState()
        ui.setSettingsTab('general')
        ui.setSettingsOpen(true)
        close()
      },
    })

    result.push({
      id: 'action-shortcuts',
      type: 'action',
      title: 'Keyboard Shortcuts',
      subtitle: 'View all keyboard shortcuts',
      icon: <Keyboard size={14} className="text-text-muted" />,
      onSelect: () => {
        useUIStore.getState().setShortcutsPanelOpen(true)
        close()
      },
    })

    return result
  }, [conversations, query, router, close])

  // Group items by type
  const conversationItems = useMemo(() => items.filter((i) => i.type === 'task'), [items])
  const actionItems = useMemo(() => items.filter((i) => i.type === 'action'), [items])
  const flatItems = useMemo(() => [...conversationItems, ...actionItems], [conversationItems, actionItems])

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1))
    }
  }, [flatItems.length, selectedIndex])

  // Keyboard navigation and focus containment. Capture Escape before global
  // shortcuts so closing the palette cannot also close an overlay behind it.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if (e.key === 'Tab') {
        const dialog = dialogRef.current
        const focusableElements = dialog ? getFocusableElements(dialog) : []
        if (!dialog || focusableElements.length === 0) {
          e.preventDefault()
          dialog?.focus({ preventScroll: true })
          return
        }

        const firstElement = focusableElements[0]
        const lastElement = focusableElements[focusableElements.length - 1]
        const activeElement = document.activeElement
        if (e.shiftKey && (activeElement === firstElement || !dialog.contains(activeElement))) {
          e.preventDefault()
          lastElement.focus({ preventScroll: true })
        } else if (!e.shiftKey && (activeElement === lastElement || !dialog.contains(activeElement))) {
          e.preventDefault()
          firstElement.focus({ preventScroll: true })
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        flatItems[selectedIndex]?.onSelect()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open, flatItems, selectedIndex, close])

  // Scroll selected item into view
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector(`[data-palette-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIndex])

  if (!open) return null

  let flatIndex = 0

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-[var(--overlay-scrim-subtle)]"
        onClick={close}
        aria-label="Close command palette"
        tabIndex={-1}
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="relative w-full max-w-[560px] mx-4 menu-surface border border-border-primary rounded-2xl overflow-hidden animate-scale-in"
        style={{ boxShadow: 'var(--shadow-xl)' }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 h-14 border-b border-border-primary">
          <Search size={15} className="text-text-muted flex-shrink-0" strokeWidth={2.25} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
            placeholder="Search tasks and actions…"
            role="combobox"
            aria-label="Search tasks and actions"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={resultsId}
            aria-activedescendant={flatItems.length > 0 ? `${optionIdPrefix}-${selectedIndex}` : undefined}
            className="bg-transparent text-[14.5px] text-text-primary placeholder:text-text-muted placeholder:[font-family:var(--font-display)] outline-none flex-1"
          />
          <kbd className="text-[10px] text-text-muted bg-bg-secondary border border-border-secondary rounded px-1.5 h-5 flex items-center font-mono font-medium">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id={resultsId}
          role="listbox"
          aria-label="Command results"
          className="max-h-[380px] overflow-y-auto p-2"
        >
          {flatItems.length === 0 ? (
            <div className="py-12 text-center">
              <div className="w-11 h-11 rounded-2xl bg-bg-secondary border border-border-primary flex items-center justify-center mx-auto mb-3">
                <Search size={18} className="text-text-tertiary" strokeWidth={1.75} />
              </div>
              <p className="text-[14px] text-text-secondary [font-family:var(--font-display)]">No results found</p>
            </div>
          ) : (
            <>
              {/* Tasks section */}
              {conversationItems.length > 0 && (
                <div className="mb-1" role="group" aria-labelledby={tasksGroupLabelId}>
                  <div className="px-3 pt-2 pb-1.5">
                    <span id={tasksGroupLabelId} className="text-[11.5px] text-text-tertiary [font-family:var(--font-display)]">
                      Tasks
                    </span>
                  </div>
                  {conversationItems.map((item) => {
                    const idx = flatIndex++
                    return (
                      <button
                        key={item.id}
                        id={`${optionIdPrefix}-${idx}`}
                        type="button"
                        role="option"
                        aria-selected={selectedIndex === idx}
                        tabIndex={-1}
                        data-palette-index={idx}
                        onClick={item.onSelect}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        className={`w-full px-2.5 py-2.5 flex items-center gap-3 text-left rounded-lg transition-all duration-100 ${
                          selectedIndex === idx ? 'bg-bg-hover' : 'hover:bg-bg-hover focus-visible:bg-bg-hover'
                        }`}
                      >
                        <div className="w-8 h-8 rounded-lg bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                          {item.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold text-text-primary truncate tracking-[0]">
                            {item.title}
                          </div>
                          <div className="text-[11.5px] text-text-muted truncate mt-0.5">
                            {item.subtitle}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

              {/* Actions section */}
              {actionItems.length > 0 && (
                <div role="group" aria-labelledby={actionsGroupLabelId}>
                  {conversationItems.length > 0 && (
                    <div className="h-px bg-border-secondary mx-3 my-1.5" role="separator" />
                  )}
                  <div className="px-3 pt-2 pb-1.5">
                    <span id={actionsGroupLabelId} className="text-[11.5px] text-text-tertiary [font-family:var(--font-display)]">
                      Actions
                    </span>
                  </div>
                  {actionItems.map((item) => {
                    const idx = flatIndex++
                    return (
                      <button
                        key={item.id}
                        id={`${optionIdPrefix}-${idx}`}
                        type="button"
                        role="option"
                        aria-selected={selectedIndex === idx}
                        tabIndex={-1}
                        data-palette-index={idx}
                        onClick={item.onSelect}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        className={`w-full px-2.5 py-2.5 flex items-center gap-3 text-left rounded-lg transition-all duration-100 ${
                          selectedIndex === idx ? 'bg-bg-hover' : 'hover:bg-bg-hover focus-visible:bg-bg-hover'
                        }`}
                      >
                        <div className="w-8 h-8 rounded-lg bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                          {item.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold text-text-primary truncate tracking-[0]">
                            {item.title}
                          </div>
                          <div className="text-[11.5px] text-text-muted truncate mt-0.5">
                            {item.subtitle}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between px-4 h-9 border-t border-border-primary bg-bg-secondary">
          <div className="flex items-center gap-3.5">
            <span className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
              <kbd className="bg-bg-card border border-border-secondary rounded px-1 h-4 flex items-center font-mono text-[9.5px]">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
              <kbd className="bg-bg-card border border-border-secondary rounded px-1 h-4 flex items-center font-mono text-[9.5px]">↵</kbd>
              select
            </span>
          </div>
          <span className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
            <kbd className="bg-bg-card border border-border-secondary rounded px-1 h-4 flex items-center font-mono text-[9.5px]">⌘K</kbd>
            toggle
          </span>
        </div>
      </div>
    </div>
  )
}
