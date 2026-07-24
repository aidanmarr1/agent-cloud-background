export function ControlTooltip({
  label,
  align = 'center',
}: {
  label: string
  align?: 'left' | 'center' | 'right'
}) {
  const alignment = align === 'left'
    ? 'left-0'
    : align === 'right'
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2'

  return (
    <span
      role="tooltip"
      className={`pointer-events-none absolute top-[calc(100%+7px)] z-[140] translate-y-1 whitespace-nowrap rounded-[10px] bg-[var(--tooltip-surface)] px-3 py-2 text-[12.5px] font-medium text-[var(--tooltip-text)] opacity-0 shadow-lg transition-[opacity,transform] duration-75 group-hover/tooltip:translate-y-0 group-hover/tooltip:opacity-100 group-focus-within/tooltip:translate-y-0 group-focus-within/tooltip:opacity-100 ${alignment}`}
    >
      {label}
    </span>
  )
}
