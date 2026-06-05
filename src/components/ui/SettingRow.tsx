'use client'

export function SettingRow({ icon: Icon, iconColor, label, description, children }: {
  icon: React.ElementType
  iconColor?: string
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-bg-secondary sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-transparent">
          <Icon size={15} className={iconColor || 'text-text-muted'} strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-text-primary tracking-[0]">{label}</div>
          {description && <div className="text-[11.5px] text-text-tertiary mt-0.5 leading-snug">{description}</div>}
        </div>
      </div>
      <div className="flex w-full flex-shrink-0 justify-end sm:w-auto">{children}</div>
    </div>
  )
}
