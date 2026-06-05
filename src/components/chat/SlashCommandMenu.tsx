'use client'

import { useRef, useEffect, type ComponentType } from 'react'
import { BookOpen } from '@/components/icons'
import type { SlashCommand } from '@/types'

const iconMap: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  BookOpen,
}

interface SlashCommandMenuProps {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (cmd: SlashCommand) => void
  visible: boolean
}

export function SlashCommandMenu({ commands, selectedIndex, onSelect, visible }: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listRef.current) return
    const active = listRef.current.querySelector('[data-active="true"]')
    if (active) {
      active.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!visible || commands.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-2 menu-surface border border-border-primary rounded-2xl overflow-hidden z-50 max-h-[300px] overflow-y-auto px-1.5 pb-1.5 pt-1 animate-scale-in"
      style={{ boxShadow: 'var(--shadow-lg)' }}
    >
      <div className="px-2.5 pb-1">
        <span className="text-[11.5px] text-text-tertiary [font-family:var(--font-display)]">Saved skills</span>
      </div>
      {commands.map((cmd, i) => {
        const Icon = iconMap[cmd.icon]
        const isActive = i === selectedIndex
        return (
          <button
            key={cmd.name}
            data-active={isActive}
            onClick={() => onSelect(cmd)}
            onMouseDown={(e) => e.preventDefault()}
            className={`w-full flex items-center gap-3 px-2.5 py-2 text-left rounded-lg transition-all duration-100 ${
              isActive ? 'bg-bg-secondary' : 'hover:bg-bg-secondary'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${
              isActive ? 'bg-bg-secondary border-border-primary' : 'bg-bg-secondary border-border-primary'
            }`}>
              {Icon && <Icon size={14} className={isActive ? 'text-accent-blue' : 'text-text-tertiary'} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold text-text-primary tracking-[0]">{cmd.label}</span>
                {cmd.source === 'skill' && (
                  <span className="flex-shrink-0 rounded border border-border-primary bg-bg-secondary px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-accent-blue">
                    Skill
                  </span>
                )}
              </div>
              <div className="text-[11px] text-text-muted truncate mt-0.5">{cmd.description}</div>
            </div>
            <span className="text-[10.5px] text-text-muted font-mono flex-shrink-0 bg-bg-secondary border border-border-secondary rounded px-1.5 h-5 flex items-center">{cmd.name}</span>
          </button>
        )
      })}
    </div>
  )
}
