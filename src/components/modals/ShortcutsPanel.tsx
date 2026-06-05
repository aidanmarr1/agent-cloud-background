'use client'

import { useState, useEffect, useMemo } from 'react'
import { X } from '@/components/icons'
import { useUIStore } from '@/store/ui'
import { getKeyboardShortcutCategories } from '@/lib/keyboardShortcuts'
import { useSettingsStore } from '@/store/settings'

export function ShortcutsPanel() {
  const open = useUIStore((s) => s.shortcutsPanelOpen)
  const setOpen = useUIStore((s) => s.setShortcutsPanelOpen)
  const sendWithEnter = useSettingsStore((s) => s.sendWithEnter)
  const [search, setSearch] = useState('')
  const categories = useMemo(() => getKeyboardShortcutCategories(sendWithEnter), [sendWithEnter])

  useEffect(() => {
    if (open) {
      setSearch('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, setOpen])

  const filtered = useMemo(() => {
    if (!search.trim()) return categories
    const q = search.toLowerCase()
    return categories
      .map((cat) => ({
        ...cat,
        shortcuts: cat.shortcuts.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.keys.some((combo) => combo.some((k) => k.toLowerCase().includes(q)))
        ),
      }))
      .filter((cat) => cat.shortcuts.length > 0)
  }, [categories, search])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
    >
      <button
        type="button"
        className="absolute inset-0 bg-[var(--overlay-scrim)] animate-fade-in cursor-default"
        onClick={() => setOpen(false)}
        aria-label="Close keyboard shortcuts"
      />
      <div
        className="relative bg-bg-primary border border-border-primary rounded-2xl w-full max-w-[620px] max-h-[78vh] overflow-hidden animate-scale-in flex flex-col"
        style={{ boxShadow: 'var(--shadow-xl)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 h-14 border-b border-border-primary flex-shrink-0">
          <h2 className="text-[17px] font-semibold text-text-primary [font-family:var(--font-display)] tracking-[0]">Keyboard Shortcuts</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
            aria-label="Close keyboard shortcuts"
          >
            <X size={14} strokeWidth={2.25} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-border-primary flex-shrink-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shortcuts…"
            className="w-full bg-bg-secondary rounded-xl px-3.5 h-9 text-[12.5px] text-text-primary placeholder:text-text-muted placeholder:[font-family:var(--font-display)] outline-none border border-border-primary focus:border-border-tertiary transition-all duration-200"
          />
        </div>

        {/* Shortcuts list */}
        <div className="overflow-y-auto px-5 py-4 flex-1">
          {filtered.length === 0 && (
            <p className="text-[14px] text-text-secondary [font-family:var(--font-display)] text-center py-8">No shortcuts found</p>
          )}
          {filtered.map((category) => (
            <div key={category.id} className="mb-5 last:mb-0">
              <h3 className="text-[12px] text-text-tertiary [font-family:var(--font-display)] mb-2 px-2">
                {category.title}
              </h3>
              <div className="bg-bg-secondary border border-border-primary rounded-xl overflow-hidden divide-y divide-border-primary">
                {category.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.id}
                    className="grid gap-2 px-3.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-text-secondary">{shortcut.title}</span>
                      <span className="mt-0.5 block truncate text-[10.5px] text-text-muted">{shortcut.description}</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {shortcut.keys.map((combo, comboIndex) => (
                        <span key={`${shortcut.id}-${comboIndex}`} className="inline-flex items-center gap-1">
                          {comboIndex > 0 && <span className="text-[10px] text-text-muted/60">or</span>}
                          {combo.map((key, keyIndex) => (
                            <span key={`${key}-${keyIndex}`} className="inline-flex items-center gap-1">
                              <kbd className="inline-flex h-[22px] min-w-[24px] items-center justify-center rounded-md border border-border-primary bg-bg-primary px-1.5 text-[10.5px] font-mono font-semibold tabular-nums text-text-secondary">
                                {key}
                              </kbd>
                              {keyIndex < combo.length - 1 && (
                                <span className="text-[10px] text-text-muted/60">+</span>
                              )}
                            </span>
                          ))}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
