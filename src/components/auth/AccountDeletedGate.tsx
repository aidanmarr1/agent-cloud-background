'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import { AlertTriangle, LogOut } from '@/components/icons'
import { ACCOUNT_DELETED_EVENT, dispatchAccountDeletedEvent } from '@/lib/accountDeletedEvent'

const AUTH_ROUTES = new Set(['/sign-in', '/sign-up'])
const ACCOUNT_STATUS_POLL_MS = 3_000

function isAuthRoute(pathname: string | null): boolean {
  return !!pathname && AUTH_ROUTES.has(pathname)
}

export function AccountDeletedGate({
  initialAccountDeleted = false,
}: {
  initialAccountDeleted?: boolean
}) {
  const pathname = usePathname()
  const { data: session, status: sessionStatus } = useSession()
  const [accountDeleted, setAccountDeleted] = useState(initialAccountDeleted)
  const [loggingOut, setLoggingOut] = useState(false)
  const authRoute = isAuthRoute(pathname)
  const deletedFromSession = session?.user?.accountDeleted === true

  const markAccountDeleted = useCallback(() => {
    setAccountDeleted(true)
  }, [])

  const checkAccount = useCallback(async () => {
    if (authRoute || sessionStatus !== 'authenticated' || accountDeleted || deletedFromSession) return
    try {
      const response = await fetch('/api/access/status', { cache: 'no-store' })
      if (response.status !== 404) return
      const body = await response.json().catch(() => null) as { accountDeleted?: unknown } | null
      if (body?.accountDeleted === true) {
        markAccountDeleted()
        dispatchAccountDeletedEvent()
      }
    } catch {
      // A transient network failure should not force a user out.
    }
  }, [accountDeleted, authRoute, deletedFromSession, markAccountDeleted, sessionStatus])

  useEffect(() => {
    if (deletedFromSession) markAccountDeleted()
  }, [deletedFromSession, markAccountDeleted])

  useEffect(() => {
    void checkAccount()
  }, [checkAccount])

  useEffect(() => {
    if (authRoute || sessionStatus !== 'authenticated' || accountDeleted) return

    const interval = window.setInterval(() => {
      void checkAccount()
    }, ACCOUNT_STATUS_POLL_MS)
    const onFocus = () => void checkAccount()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkAccount()
      }
    }
    const onPageShow = () => void checkAccount()

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [accountDeleted, authRoute, checkAccount, sessionStatus])

  useEffect(() => {
    if (authRoute || sessionStatus !== 'authenticated') return

    const onAccountDeleted = () => markAccountDeleted()
    window.addEventListener(ACCOUNT_DELETED_EVENT, onAccountDeleted)
    return () => {
      window.removeEventListener(ACCOUNT_DELETED_EVENT, onAccountDeleted)
    }
  }, [authRoute, markAccountDeleted, sessionStatus])

  useEffect(() => {
    if (!accountDeleted) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [accountDeleted])

  const handleLogout = () => {
    setLoggingOut(true)
    void signOut({ callbackUrl: '/sign-in' })
  }

  if (!(accountDeleted || deletedFromSession) || authRoute) return null

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm animate-fade-in" />
      <section
        role="alertdialog"
        aria-modal="true"
        aria-label="Account deleted"
        className="relative flex w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-border-primary bg-bg-primary shadow-xl"
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)', boxShadow: 'var(--shadow-xl)' }}
      >
        <div className="p-6">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary text-text-secondary">
            <AlertTriangle size={21} strokeWidth={2.25} />
          </div>
          <h2 className="text-[21px] font-semibold tracking-[0] text-text-primary">Your account has been deleted.</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
            Your Agent account has been removed. Log out to return to sign in.
          </p>

          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 text-[13.5px] font-semibold text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-red/30 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-65"
          >
            <LogOut size={15} strokeWidth={2.25} />
            {loggingOut ? 'Logging out...' : 'Log out'}
          </button>
        </div>
      </section>
    </div>
  )
}
