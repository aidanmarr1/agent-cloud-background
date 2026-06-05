import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const RETURN_TO_COOKIE = 'agent-auth-return-to'

function safeReturnPath(value: string | null): string | null {
  const path = value?.trim()
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null
  if (path === '/sign-in' || path.startsWith('/sign-in?') || path === '/sign-up' || path.startsWith('/sign-up?')) {
    return null
  }
  return path
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/sign-in') {
    const returnTo = safeReturnPath(request.nextUrl.searchParams.get('next')) ??
      safeReturnPath(request.nextUrl.searchParams.get('callbackUrl'))

    if (returnTo || request.nextUrl.searchParams.has('next') || request.nextUrl.searchParams.has('callbackUrl')) {
      const cleanUrl = request.nextUrl.clone()
      cleanUrl.search = ''
      const response = NextResponse.redirect(cleanUrl)
      if (returnTo) {
        response.cookies.set(RETURN_TO_COOKIE, returnTo, {
          path: '/',
          maxAge: 5 * 60,
          sameSite: 'lax',
          secure: request.nextUrl.protocol === 'https:',
        })
      }
      return response
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
