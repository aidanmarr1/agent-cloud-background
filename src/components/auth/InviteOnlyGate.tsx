'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowRight, CheckCircle2, Loader2, ShieldCheck, Sparkles } from '@/components/icons'
import { ACCOUNT_DELETED_EVENT, dispatchAccountDeletedEvent } from '@/lib/accountDeletedEvent'
import { useCreditStore } from '@/store/credits'

type AccessStatusResponse = {
  accessStatus?: 'pending' | 'approved'
  creditsLocked?: boolean
  requestStatus?: 'pending' | 'accepted' | 'declined' | null
  requested?: boolean
  approvedAt?: string | null
}

const AUTH_ROUTES = new Set(['/sign-in', '/sign-up'])
const DISMISSED_KEY_PREFIX = 'agent-access-approved-dismissed'

function isAuthRoute(pathname: string | null): boolean {
  return !!pathname && AUTH_ROUTES.has(pathname)
}

function dismissedKey(email: string | null | undefined, approvedAt: string | null | undefined): string {
  return `${DISMISSED_KEY_PREFIX}:${email || 'user'}:${approvedAt || 'approved'}`
}

export function InviteOnlyGate({
  initialAccessStatus,
  initialAccountDeleted = false,
}: {
  initialAccessStatus?: 'pending' | 'approved'
  initialAccountDeleted?: boolean
}) {
  const pathname = usePathname()
  const { data: session, status: sessionStatus } = useSession()
  const syncCredits = useCreditStore((s) => s.syncFromServer)
  const [status, setStatus] = useState<AccessStatusResponse | null>(
    initialAccessStatus ? { accessStatus: initialAccessStatus } : null,
  )
  const [requesting, setRequesting] = useState(false)
  const [requestError, setRequestError] = useState('')
  const [approvedDismissed, setApprovedDismissed] = useState(false)
  const [accountDeleted, setAccountDeleted] = useState(initialAccountDeleted)

  const authRoute = isAuthRoute(pathname)
  const email = session?.user?.email || null
  const deletedFromSession = session?.user?.accountDeleted === true
  const deleted = accountDeleted || deletedFromSession
  const serverAccessStatus = status?.accessStatus
  const pending = serverAccessStatus
    ? serverAccessStatus === 'pending'
    : session?.user?.accessStatus === 'pending'
  const approvedByRequest = status?.accessStatus === 'approved' && status.requestStatus === 'accepted'
  const visible = !deleted && !authRoute && (
    pending || (sessionStatus === 'authenticated' && approvedByRequest && !approvedDismissed)
  )

  const approvalDismissedKey = useMemo(
    () => dismissedKey(email, status?.approvedAt || null),
    [email, status?.approvedAt],
  )

  const refreshStatus = useCallback(async () => {
    if (authRoute || sessionStatus !== 'authenticated') return
    try {
      const response = await fetch('/api/access/status', { cache: 'no-store' })
      if (!response.ok) {
        if (response.status === 404) {
          const body = await response.json().catch(() => null) as { accountDeleted?: unknown } | null
          if (body?.accountDeleted === true) {
            setAccountDeleted(true)
            dispatchAccountDeletedEvent()
          }
        }
        return
      }
      const body = await response.json() as AccessStatusResponse
      setStatus(body)
      if (body.accessStatus === 'approved') {
        void syncCredits()
      }
    } catch {
      // Access will be checked again when the tab focuses or the next poll runs.
    }
  }, [authRoute, sessionStatus, syncCredits])

  useEffect(() => {
    if (deletedFromSession) {
      setAccountDeleted(true)
    }
  }, [deletedFromSession])

  useEffect(() => {
    const onAccountDeleted = () => setAccountDeleted(true)
    window.addEventListener(ACCOUNT_DELETED_EVENT, onAccountDeleted)
    return () => {
      window.removeEventListener(ACCOUNT_DELETED_EVENT, onAccountDeleted)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!pending) return
    void refreshStatus()
    const interval = window.setInterval(() => {
      void refreshStatus()
    }, 5_000)
    const onFocus = () => void refreshStatus()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshStatus()
      }
    }
    const onPageShow = () => void refreshStatus()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [pending, refreshStatus])

  useEffect(() => {
    if (!approvedByRequest) return
    try {
      setApprovedDismissed(window.localStorage.getItem(approvalDismissedKey) === '1')
    } catch {
      setApprovedDismissed(false)
    }
  }, [approvalDismissedKey, approvedByRequest])

  const requestApproval = async () => {
    setRequesting(true)
    setRequestError('')
    try {
      const response = await fetch('/api/access/request', {
        method: 'POST',
      })
      const body = await response.json().catch(() => null) as { error?: string } | AccessStatusResponse | null
      if (!response.ok) {
        const error = typeof (body as { error?: unknown } | null)?.error === 'string'
          ? (body as { error: string }).error
          : 'Could not send the approval request.'
        setRequestError(error)
        return
      }
      const accessBody = body && 'accessStatus' in body ? body : null
      if (accessBody?.accessStatus === 'approved') {
        setStatus((current) => ({
          ...(current || {}),
          accessStatus: 'approved',
          requestStatus: accessBody.requestStatus || 'accepted',
          requested: false,
          creditsLocked: false,
        }))
        void syncCredits()
        return
      }
      setStatus((current) => ({
        ...(current || {}),
        accessStatus: 'pending',
        requestStatus: accessBody?.requestStatus || 'pending',
        requested: true,
        creditsLocked: true,
      }))
    } catch {
      setRequestError('Could not send the approval request.')
    } finally {
      setRequesting(false)
    }
  }

  const dismissApproved = () => {
    try {
      window.localStorage.setItem(approvalDismissedKey, '1')
    } catch {
      // Ignore storage failures; the button should still hide the modal for this render.
    }
    setApprovedDismissed(true)
    void syncCredits()
  }

  if (!visible) return null

  const requestSent = status?.requested || status?.requestStatus === 'pending'

  return (
    <div className="fixed inset-0 z-[190] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm animate-fade-in" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={approvedByRequest ? 'Agent 1.0 access ready' : 'Agent 1.0 invite only'}
        className="relative flex w-[min(440px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-border-primary bg-bg-primary shadow-xl"
        style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)', boxShadow: 'var(--shadow-xl)' }}
      >
        {approvedByRequest ? (
          <div className="p-6">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary text-accent-blue">
              <CheckCircle2 size={21} strokeWidth={2.25} />
            </div>
            <h2 className="text-[21px] font-semibold tracking-[0] text-text-primary">Congrats. Enjoy Agent 1.0.</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
              Your access is approved and your free 1,000 credits are ready for your first tasks.
            </p>
            <button
              type="button"
              onClick={dismissApproved}
              className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-text-primary px-4 text-[13.5px] font-semibold text-bg-primary transition-all hover:opacity-90 active:scale-[0.99]"
            >
              Start using Agent 1.0
              <ArrowRight size={14} strokeWidth={2.25} />
            </button>
          </div>
        ) : (
          <div className="p-6">
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary text-text-primary">
              <ShieldCheck size={21} strokeWidth={2.25} />
            </div>
            <h2 className="text-[21px] font-semibold tracking-[0] text-text-primary">Agent 1.0 is invite-only.</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
              Your account is ready, but tasks are locked until access is approved. Request access to receive your free 1,000 credits.
            </p>

            <div className="mt-5 rounded-xl border border-border-primary bg-bg-secondary px-3.5 py-3">
              <div className="flex items-start gap-3">
                <Sparkles size={16} className="mt-0.5 text-accent-blue" strokeWidth={2.25} />
                <div>
                  <div className="text-[12.5px] font-semibold text-text-primary">
                    {requestSent ? 'Request sent' : 'Request access'}
                  </div>
                  <div className="mt-1 text-[12px] leading-relaxed text-text-tertiary">
                    {requestSent
                      ? 'We will review your request. When access is ready, this message will update automatically.'
                      : 'When access is approved, your 1,000 credits will be added automatically.'}
                  </div>
                </div>
              </div>
            </div>

            {requestError && (
              <div className="mt-3 rounded-xl border border-accent-red/20 bg-accent-red/5 px-3 py-2.5 text-[12px] text-accent-red">
                {requestError}
              </div>
            )}

            <button
              type="button"
              onClick={requestApproval}
              disabled={requesting || requestSent}
              className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-text-primary px-4 text-[13.5px] font-semibold text-bg-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {requesting ? (
                <>
                  <Loader2 size={14} className="animate-spin" strokeWidth={2.25} />
                  Sending request
                </>
              ) : requestSent ? (
                'Request sent'
              ) : (
                <>
                  Request access
                  <ArrowRight size={14} strokeWidth={2.25} />
                </>
              )}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
