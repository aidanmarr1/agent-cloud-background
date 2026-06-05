'use client'

import { useUIStore } from '@/store/ui'
import { X, AlertCircle, CheckCircle, Info } from '@/components/icons'

export function Toast() {
  const toasts = useUIStore((s) => s.toasts)
  const removeToast = useUIStore((s) => s.removeToast)
  const dismissingToasts = useUIStore((s) => s.dismissingToasts)

  if (toasts.length === 0) return null

  const visibleToasts = toasts.slice(-3)

  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2">
      {visibleToasts.map((toast) => {
        const Icon = toast.type === 'error' ? AlertCircle : toast.type === 'success' ? CheckCircle : Info
        const color = toast.type === 'error' ? 'text-accent-red' : toast.type === 'success' ? 'text-text-secondary' : 'text-accent-blue'
        const bgColor = toast.type === 'error' ? 'bg-accent-red/10' : toast.type === 'success' ? 'bg-bg-secondary' : 'bg-bg-secondary'
        const progressColor = toast.type === 'error' ? 'bg-accent-red' : toast.type === 'success' ? 'bg-text-secondary' : 'bg-accent-blue'
        const isDismissing = dismissingToasts.has(toast.id)

        return (
          <div
            key={toast.id}
            className={`relative overflow-hidden flex items-center gap-3 bg-bg-card border border-border-primary rounded-2xl pl-3.5 pr-2 py-3 ${isDismissing ? 'animate-slide-out-right' : 'animate-slide-in-from-right'} min-w-[280px] max-w-[420px]`}
            style={{ boxShadow: 'var(--shadow-xl)' }}
          >
            <div className={`w-8 h-8 rounded-xl ${bgColor} flex items-center justify-center flex-shrink-0`}>
              <Icon size={15} className={color} strokeWidth={2.25} />
            </div>
            <span className="text-[13px] text-text-primary flex-1 leading-snug font-medium tracking-[0]">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary flex-shrink-0 transition-all duration-150"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
            {/* Auto-dismiss progress bar — duration must match the auto-dismiss timer in src/store/ui.ts (4000ms) */}
            <div className="absolute bottom-0 left-0 right-0 h-[2px]">
              <div
                className={`h-full ${progressColor} opacity-60`}
                style={{ animation: 'shrinkWidth 4s linear forwards', width: '100%' }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
