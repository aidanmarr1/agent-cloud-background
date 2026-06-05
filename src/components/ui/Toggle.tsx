'use client'

export function Toggle({ enabled, onChange, label = 'Toggle setting' }: {
  enabled: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      className={`relative h-[24px] w-[42px] flex-shrink-0 rounded-full border p-[2px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-active/35 ${
        enabled ? 'border-[var(--accent-active)] bg-[var(--accent-active)]' : 'border-border-primary bg-bg-tertiary'
      }`}
    >
      <div
        className={`h-[18px] w-[18px] rounded-full transition-transform duration-200 ease-out ${
          enabled ? 'translate-x-[18px] bg-toggle-thumb' : 'translate-x-0 bg-text-tertiary'
        }`}
        style={{
          boxShadow: 'var(--toggle-thumb-shadow)',
        }}
      />
    </button>
  )
}
