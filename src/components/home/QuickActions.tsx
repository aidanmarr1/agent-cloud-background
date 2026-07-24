'use client'

import {
  Globe,
  MonitorPlay,
  FolderOpen,
  Search,
  BarChart3,
  FileText,
  Sparkles,
  ChevronDown,
} from '@/components/icons'
import { useEffect, useState } from 'react'

interface QuickActionsProps {
  onAction: (text: string) => void
}

export const QUICK_ACTIONS = [
  {
    label: 'Research',
    description: 'Find clear answers and useful sources',
    icon: Search,
    prompt: 'Research ',
    shortcut: '1',
  },
  {
    label: 'Create a website',
    description: 'Turn an idea into a polished site',
    icon: Globe,
    prompt: 'Build me a website for ',
    shortcut: '2',
  },
  {
    label: 'Get something done online',
    description: 'Navigate websites and handle the steps',
    icon: MonitorPlay,
    prompt: 'Go to ',
    shortcut: '3',
  },
  {
    label: 'Use my files',
    description: 'Read, organize, summarize, or transform',
    icon: FolderOpen,
    prompt: 'Use my attached files to ',
    shortcut: '4',
  },
  {
    label: 'Understand my data',
    description: 'Find patterns and explain what matters',
    icon: BarChart3,
    prompt: 'Help me understand this data: ',
    shortcut: '5',
  },
  {
    label: 'Help me write',
    description: 'Draft, rewrite, or sharpen anything',
    icon: FileText,
    prompt: 'Help me write ',
    shortcut: '6',
  },
  {
    label: 'Think through ideas',
    description: 'Generate options and make them stronger',
    icon: Sparkles,
    prompt: 'Help me brainstorm ideas for ',
    shortcut: '7',
  },
] as const

export function QuickActions({ onAction }: QuickActionsProps) {
  const [showMore, setShowMore] = useState(false)
  const primaryActionIndexes = [0, 1, 3, 5]
  const primaryActions = primaryActionIndexes.map((index) => QUICK_ACTIONS[index])
  const secondaryActions = QUICK_ACTIONS.filter((action) => !primaryActions.includes(action))

  // Global keyboard shortcuts — digits 1-7 fire the matching action.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('input, textarea, select, button, [contenteditable="true"], [role="textbox"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return

      const idx = parseInt(e.key, 10)
      if (!Number.isNaN(idx) && idx >= 1 && idx <= QUICK_ACTIONS.length) {
        e.preventDefault()
        onAction(QUICK_ACTIONS[idx - 1].prompt)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onAction])

  return (
    <section
      className="mx-auto mt-4 w-full max-w-[780px]"
      aria-labelledby="quick-actions-heading"
    >
      <h2 id="quick-actions-heading" className="sr-only">Quick actions</h2>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {primaryActions.map(({ label, description, icon: Icon, prompt, shortcut }) => (
          <button
            key={label}
            type="button"
            onClick={() => onAction(prompt)}
            className="group flex h-10 items-center gap-2 rounded-full border border-border-primary bg-transparent px-3.5 text-[12.5px] font-semibold text-text-secondary transition-colors hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
            aria-label={`${label}: ${description}. Keyboard shortcut ${shortcut}`}
            aria-keyshortcuts={shortcut}
          >
            <Icon size={15} className="text-text-muted transition-colors group-hover:text-text-secondary" strokeWidth={2} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowMore((open) => !open)}
          className="flex h-10 items-center gap-2 rounded-full border border-border-primary bg-transparent px-3.5 text-[12.5px] font-semibold text-text-secondary transition-colors hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
          aria-expanded={showMore}
          aria-controls="more-quick-actions"
        >
          <span>{showMore ? 'Less' : 'More'}</span>
          <ChevronDown size={14} className={`text-text-muted transition-transform duration-200 ${showMore ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      </div>

      {showMore && (
        <div id="more-quick-actions" className="mt-2 flex flex-wrap items-center justify-center gap-2 animate-fade-in">
          {secondaryActions.map(({ label, description, icon: Icon, prompt, shortcut }) => (
            <button
              key={label}
              type="button"
              onClick={() => onAction(prompt)}
              className="group flex h-10 items-center gap-2 rounded-full border border-border-primary bg-transparent px-3.5 text-[12.5px] font-semibold text-text-secondary transition-colors hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
              aria-label={`${label}: ${description}. Keyboard shortcut ${shortcut}`}
              aria-keyshortcuts={shortcut}
            >
              <Icon size={15} className="text-text-muted transition-colors group-hover:text-text-secondary" strokeWidth={2} aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
