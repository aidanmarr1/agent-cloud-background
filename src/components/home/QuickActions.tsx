'use client'

import {
  Globe,
  MonitorPlay,
  FolderOpen,
  Search,
  BarChart3,
  FileText,
  Sparkles,
  MoreHorizontal,
} from '@/components/icons'
import { useEffect, useRef, useState } from 'react'
import { useClickOutside } from '@/lib/useClickOutside'

interface QuickActionsProps {
  onAction: (text: string) => void
}

export const QUICK_ACTIONS = [
  {
    label: 'Research',
    description: 'Deep dive into any topic',
    icon: Search,
    prompt: 'Research ',
    accent: 'var(--accent-blue)',
    shortcut: '1',
  },
  {
    label: 'Build website',
    description: 'Design and develop web pages',
    icon: Globe,
    prompt: 'Build me a website for ',
    accent: 'var(--text-secondary)',
    shortcut: '2',
  },
  {
    label: 'Automate web',
    description: 'Navigate sites and complete tasks',
    icon: MonitorPlay,
    prompt: 'Go to ',
    accent: 'var(--accent-blue)',
    shortcut: '3',
  },
  {
    label: 'Work with files',
    description: 'Read, summarize, and transform files',
    icon: FolderOpen,
    prompt: 'Analyze the attached files and ',
    accent: 'var(--text-secondary)',
    shortcut: '4',
  },
  {
    label: 'Analyze data',
    description: 'Process and visualize datasets',
    icon: BarChart3,
    prompt: 'Analyze the data ',
    accent: 'var(--text-secondary)',
    shortcut: '5',
  },
  {
    label: 'Write',
    description: 'Draft and edit documents',
    icon: FileText,
    prompt: 'Write a ',
    accent: 'var(--accent-red)',
    shortcut: '6',
  },
  {
    label: 'Brainstorm',
    description: 'Generate and refine ideas',
    icon: Sparkles,
    prompt: 'Brainstorm ideas for ',
    accent: 'var(--accent-blue)',
    shortcut: '7',
  },
] as const

const PRIMARY_ACTIONS = QUICK_ACTIONS.slice(0, 4)
const MORE_ACTIONS = QUICK_ACTIONS.slice(4)

export function QuickActions({ onAction }: QuickActionsProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useClickOutside(moreRef, () => setMoreOpen(false))

  const selectAction = (prompt: string) => {
    setMoreOpen(false)
    onAction(prompt)
  }

  // Global keyboard shortcuts — digits 1-8 fire the matching action.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input or has a modifier held
      const target = e.target as HTMLElement | null
      if (!target) return
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

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
    <div className="w-full max-w-[810px] mx-auto mt-3 px-3">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {PRIMARY_ACTIONS.map(({ label, description, icon: Icon, prompt, shortcut }) => (
          <button
            key={label}
            type="button"
            onClick={() => selectAction(prompt)}
            className="group h-10 px-3 rounded-xl border border-border-primary bg-bg-primary hover:bg-bg-secondary hover:border-border-tertiary active:scale-[0.98] transition-card flex items-center gap-2 cursor-pointer will-change-transform"
            aria-label={`${label}: ${description}. Keyboard shortcut ${shortcut}`}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-muted transition-colors group-hover:text-text-primary">
              <Icon
                size={15}
                strokeWidth={1.95}
                aria-hidden
              />
            </span>
            <span className="text-[12.5px] font-semibold text-text-primary leading-none">
              {label}
            </span>
          </button>
        ))}

        <div ref={moreRef} className="relative">
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            className="group h-10 px-3 rounded-xl border border-border-primary bg-bg-primary hover:bg-bg-secondary hover:border-border-tertiary active:scale-[0.98] transition-card flex items-center gap-2 cursor-pointer"
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            aria-label="Show more task starters"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-muted transition-colors group-hover:text-text-primary">
              <MoreHorizontal
                size={16}
                strokeWidth={1.95}
                aria-hidden
              />
            </span>
            <span className="text-[12.5px] font-semibold text-text-primary leading-none">More</span>
          </button>

          {moreOpen && (
            <div
              className="absolute left-1/2 top-full z-50 mt-2 w-[280px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-border-primary menu-surface p-1.5 animate-scale-in origin-top sm:left-full sm:top-0 sm:ml-2 sm:mt-0 sm:translate-x-0 sm:origin-top-left"
              style={{ boxShadow: 'var(--shadow-lg)' }}
              role="menu"
            >
              {MORE_ACTIONS.map(({ label, description, icon: Icon, prompt, shortcut }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => selectAction(prompt)}
                  className="group w-full rounded-xl px-2.5 py-2.5 text-left hover:bg-bg-secondary transition-colors flex items-center gap-3"
                  role="menuitem"
                  aria-label={`${label}: ${description}. Keyboard shortcut ${shortcut}`}
                >
                  <span className="flex h-5 w-5 items-center justify-center shrink-0">
                    <Icon
                      size={15}
                      strokeWidth={1.9}
                      className="text-text-muted transition-colors group-hover:text-text-primary"
                      aria-hidden
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-text-primary leading-tight">
                      {label}
                    </span>
                    <span className="block text-[11.5px] text-text-tertiary leading-snug truncate">
                      {description}
                    </span>
                  </span>
                  <span className="ml-auto text-[10px] font-mono tabular-nums text-text-muted/65">
                    {shortcut}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
