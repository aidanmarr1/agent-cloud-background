'use client'

export function SettingRow({ label, description, children }: {
  icon: React.ElementType
  iconColor?: string
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-0 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-1 items-center">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-text-primary tracking-[0]">{label}</div>
          {description && <div className="mt-1 text-[12px] leading-relaxed text-text-tertiary">{description}</div>}
        </div>
      </div>
      <div className="flex w-full flex-shrink-0 justify-end sm:w-auto">{children}</div>
    </div>
  )
}
