'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

const AUTH_ROUTES = new Set(['/sign-in', '/sign-up'])
const RETURN_TO_STORAGE_KEY = 'agent-auth-return-to'

function isAuthRoute(pathname: string | null): boolean {
  return !!pathname && AUTH_ROUTES.has(pathname)
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()
  const authRoute = isAuthRoute(pathname)
  const hasSession = !!session?.user?.id

  useEffect(() => {
    if (status !== 'unauthenticated' || authRoute) return

    const returnTo = typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
      : pathname || '/'
    try {
      window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, returnTo)
    } catch {
      // Session storage can be disabled; falling back to the home route is safe.
    }
    router.replace('/sign-in')
  }, [authRoute, pathname, router, status])

  if (authRoute) {
    return <>{children}</>
  }

  if (status === 'loading') {
    return <>{children}</>
  }

  if (status === 'unauthenticated' && !hasSession) {
    return null
  }

  return <>{children}</>
}
