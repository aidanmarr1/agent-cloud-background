'use client'

import { LucideIcon } from '@/components/icons'
import { useState } from 'react'

interface SidebarItemProps {
  icon: LucideIcon
  tooltip: string
  shortcut?: string
  active?: boolean
  badge?: number
  variant?: 'default' | 'primary'
  expanded?: boolean
  onClick?: () => void
}

export function SidebarItem({ icon: Icon, tooltip, shortcut, active, badge, variant = 'default', expanded = false, onClick }: SidebarItemProps) {
  const [hovered, setHovered] = useState(false)
  const isPrimary = variant === 'primary'

  return (
    <div className="relative w-full flex justify-center">
      {/* Active rail — anchored to the sidebar's left edge */}
      <div
        aria-hidden="true"
        className={`absolute left-[-12px] top-1/2 -translate-y-1/2 w-[3px] bg-accent-blue rounded-r-full transition-all duration-300 ease-out ${
          active ? 'h-6 opacity-100 scale-y-100' : 'h-2 opacity-0 scale-y-50'
        }`}
      />
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`group relative h-10 rounded-lg flex items-center transition-all duration-300 ease-out active:scale-[0.96] ${
          expanded ? 'w-full pl-2.5 pr-2 gap-3 justify-start' : 'w-10 justify-center'
        } ${
          isPrimary
            ? 'bg-text-primary text-primary-foreground hover:opacity-90'
            : active
              ? 'bg-bg-tertiary text-text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
        }`}
        style={
          isPrimary
            ? { boxShadow: 'var(--shadow-md)' }
            : active
              ? { boxShadow: 'var(--shadow-sm)' }
              : undefined
        }
      >
        <div className="w-5 flex items-center justify-center flex-shrink-0">
          <Icon size={17} strokeWidth={isPrimary ? 2.5 : active ? 2.2 : 1.85} />
        </div>

        {/* Label — visible when sidebar is expanded */}
        <span
          className={`text-[13px] font-medium tracking-[0] whitespace-nowrap transition-all duration-200 ${
            expanded ? 'opacity-100 translate-x-0 delay-100' : 'opacity-0 -translate-x-1 pointer-events-none w-0 overflow-hidden'
          }`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
        >
          {tooltip}
        </span>

        {/* Shortcut hint — only when expanded */}
        {expanded && shortcut && (
          <kbd
            className={`ml-auto text-[9.5px] font-mono font-medium ${
              isPrimary
                ? 'text-primary-foreground/60 bg-primary-foreground/10 border-primary-foreground/15'
                : 'text-text-muted bg-bg-card border-border-primary'
            } border rounded-md px-1.5 h-5 flex items-center tabular-nums transition-opacity duration-200 delay-150`}
          >
            {shortcut}
          </kbd>
        )}

        {/* Badge */}
        {badge !== undefined && badge > 0 && !expanded && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full bg-accent-blue text-text-on-blue text-[9px] font-bold flex items-center justify-center px-1 leading-none ring-2 ring-bg-secondary">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>

      {/* Tooltip with arrow — only when sidebar is collapsed */}
      {!expanded && hovered && (
        <div
          role="tooltip"
          className="absolute left-[52px] top-1/2 -translate-y-1/2 z-[60] pointer-events-none animate-[tooltipIn_0.18s_cubic-bezier(0.16,1,0.3,1)_0.15s_backwards]"
        >
          <div
            aria-hidden="true"
            className="absolute -left-[5px] top-1/2 h-[10px] w-[10px] -translate-y-1/2 rotate-45 bg-[var(--tooltip-surface)]"
          />
          <div
            className="relative flex h-8 items-center gap-2 whitespace-nowrap rounded-xl bg-[var(--tooltip-surface)] px-3 text-[11.5px] text-[var(--tooltip-text)]"
            style={{ boxShadow: 'var(--shadow-xl)' }}
          >
            <span className="font-semibold tracking-[0]">{tooltip}</span>
            {shortcut && (
              <kbd className="flex h-5 items-center rounded-md border border-white/15 bg-white/10 px-1.5 font-mono text-[10px] font-medium tabular-nums text-[var(--tooltip-muted)]">{shortcut}</kbd>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
