'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Monitor } from '@/components/icons'

const AUTH_ROUTES = new Set(['/sign-in', '/sign-up'])
const MOBILE_QUERY = '(max-width: 767px)'

function isAuthRoute(pathname: string | null): boolean {
  return !!pathname && AUTH_ROUTES.has(pathname)
}

function useIsMobileViewport(): boolean {
  const [mobile, setMobile] = useState(false)

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY)
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return mobile
}

export function MobileUnsupportedGate() {
  const pathname = usePathname()
  const { status } = useSession()
  const mobile = useIsMobileViewport()
  const visible = status === 'authenticated' && mobile && !isAuthRoute(pathname)

  useEffect(() => {
    if (!visible) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [visible])

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm animate-fade-in" />
      <section
        tabIndex={-1}
        data-no-focus-ring
        role="alertdialog"
        aria-modal="true"
        aria-label="Desktop required"
        className="relative flex w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-border-primary bg-bg-primary shadow-xl outline-none"
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)', boxShadow: 'var(--shadow-xl)' }}
      >
        <div className="p-6">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary text-text-primary">
            <Monitor size={21} strokeWidth={2.25} />
          </div>
          <h2 className="text-[21px] font-semibold tracking-[0] text-text-primary">
            Desktop required
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
            Agent is not mobile optimized yet. Please view on desktop.
          </p>
        </div>
      </section>
    </div>
  )
}
