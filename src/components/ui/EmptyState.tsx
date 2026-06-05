'use client'

import { type LucideIcon } from '@/components/icons'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center animate-fade-in">
      <div className="w-12 h-12 rounded-2xl bg-bg-secondary border border-border-primary flex items-center justify-center mb-5">
        <Icon size={20} className="text-text-tertiary" strokeWidth={1.75} />
      </div>
      <p className="text-[17px] text-text-primary [font-family:var(--font-display)] tracking-[0]">
        {title}
      </p>
      {description && (
        <p className="text-[12.5px] text-text-tertiary mt-2 max-w-[280px] leading-relaxed">
          {description}
        </p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="text-[12.5px] font-medium text-accent-blue hover:text-accent-blue/80 cursor-pointer mt-4 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
