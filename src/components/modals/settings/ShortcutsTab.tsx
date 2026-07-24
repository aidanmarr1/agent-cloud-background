'use client'

import type { ComponentType } from 'react'
import { useState } from 'react'
import { ChevronDown, Keyboard, LayoutGrid, MessageSquare, Monitor, Search } from '@/components/icons'
import { getKeyboardShortcutCategories, type ShortcutCategory, type ShortcutItem } from '@/lib/keyboardShortcuts'
import { useSettingsStore } from '@/store/settings'
import { SettingsSection } from './SettingsSection'

const categoryIcons: Record<string, ComponentType<{ size?: number; className?: string; strokeWidth?: number }>> = {
  global: Keyboard,
  workspace: Monitor,
  composer: MessageSquare,
  menus: Search,
  home: LayoutGrid,
}

function ShortcutKeys({ keys }: { keys: string[][] }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {keys.map((combo, comboIndex) => (
        <span key={`${combo.join('-')}-${comboIndex}`} className="inline-flex items-center gap-1">
          {comboIndex > 0 && <span className="text-[10px] font-medium text-text-muted/70">or</span>}
          <span className="inline-flex items-center gap-1">
            {combo.map((key, keyIndex) => (
              <span key={`${key}-${keyIndex}`} className="inline-flex items-center gap-1">
                <kbd className="flex min-h-[24px] min-w-[26px] items-center justify-center rounded-md border border-border-primary bg-bg-primary px-1.5 text-[10.5px] font-semibold tabular-nums text-text-secondary shadow-[inset_0_-1px_0_var(--control-inset-highlight)]">
                  {key}
                </kbd>
                {keyIndex < combo.length - 1 && (
                  <span className="text-[10px] text-text-muted/55">+</span>
                )}
              </span>
            ))}
          </span>
        </span>
      ))}
    </div>
  )
}

function ShortcutRow({ shortcut }: { shortcut: ShortcutItem }) {
  return (
    <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-text-primary tracking-[0]">
            {shortcut.title}
          </span>
          {shortcut.context && (
            <span className="rounded-md border border-border-primary bg-bg-primary px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-text-muted">
              {shortcut.context}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-text-tertiary">
          {shortcut.description}
        </p>
      </div>
      <ShortcutKeys keys={shortcut.keys} />
    </div>
  )
}

function ShortcutCategoryCard({
  category,
  open,
  onToggle,
}: {
  category: ShortcutCategory
  open: boolean
  onToggle: () => void
}) {
  const Icon = categoryIcons[category.id] || Keyboard

  return (
    <section className="overflow-hidden rounded-xl border border-border-primary bg-bg-card">
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-blue/35 ${open ? 'border-b border-border-primary' : ''}`}
        aria-expanded={open}
      >
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary">
          <Icon size={15} className="text-accent-blue" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-[13px] font-semibold text-text-primary tracking-[0]">
            {category.title}
          </h4>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            {category.description}
          </p>
        </div>
        <span className="rounded-md border border-border-primary bg-bg-secondary px-2 py-1 text-[10.5px] font-semibold tabular-nums text-text-tertiary">
          {category.shortcuts.length}
        </span>
        <ChevronDown
          size={14}
          className={`flex-shrink-0 text-text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          strokeWidth={2.25}
        />
      </button>
      {open && (
        <div className="divide-y divide-border-primary">
          {category.shortcuts.map((shortcut) => (
            <ShortcutRow key={shortcut.id} shortcut={shortcut} />
          ))}
        </div>
      )}
    </section>
  )
}

export function ShortcutsTab() {
  const sendWithEnter = useSettingsStore((s) => s.sendWithEnter)
  const categories = getKeyboardShortcutCategories(sendWithEnter)
  const [openCategories, setOpenCategories] = useState<Set<string>>(() =>
    new Set(['global', 'composer'])
  )

  const toggleCategory = (categoryId: string) => {
    setOpenCategories((current) => {
      const next = new Set(current)
      if (next.has(categoryId)) {
        next.delete(categoryId)
      } else {
        next.add(categoryId)
      }
      return next
    })
  }

  return (
    <SettingsSection
      title="Keyboard shortcuts"
      description="Reference commands by the part of Agent where they work."
    >
      <div className="mb-3 flex flex-col gap-2.5 rounded-xl border border-border-primary bg-bg-secondary px-3.5 py-3 text-[11.5px] leading-relaxed text-text-tertiary sm:flex-row sm:items-center sm:justify-between">
        <span>Use Ctrl in place of ⌘ on Windows and Linux. Typing fields ignore global shortcuts unless they use ⌘/Ctrl.</span>
        <span className="w-fit flex-shrink-0 rounded-md border border-border-primary bg-bg-primary px-2.5 py-1 text-[10.5px] font-semibold text-text-secondary">
          {sendWithEnter ? 'Enter sends' : '⌘/Ctrl + Enter sends'}
        </span>
      </div>
      <div className="space-y-2.5">
        {categories.map((category) => (
          <ShortcutCategoryCard
            key={category.id}
            category={category}
            open={openCategories.has(category.id)}
            onToggle={() => toggleCategory(category.id)}
          />
        ))}
      </div>
    </SettingsSection>
  )
}
