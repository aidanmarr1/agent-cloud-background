import type { ReactNode } from 'react'

export const settingsPanelClass = 'overflow-hidden border-y border-border-secondary'

export function SettingsSection({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text-primary">{title}</h3>
          {description && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-text-tertiary">{description}</p>
          )}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}
