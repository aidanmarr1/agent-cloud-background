'use client'

import Link from 'next/link'
import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { AlertCircle, ArrowRight } from '@/components/icons'

const RETURN_TO_STORAGE_KEY = 'agent-auth-return-to'
const RETURN_TO_COOKIE = 'agent-auth-return-to'
const SIGN_IN_TIMEOUT_MS = 10_000
const SIGN_IN_TIMEOUT_ERROR = 'SIGN_IN_TIMEOUT'

function safeReturnPath(value: string | null): string | null {
  const path = value?.trim()
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    return null
  }
  if (path === '/sign-in' || path.startsWith('/sign-in?') || path === '/sign-up' || path.startsWith('/sign-up?')) {
    return null
  }
  return path
}

function getReturnPathFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search)
  return safeReturnPath(params.get('next')) ?? safeReturnPath(params.get('callbackUrl'))
}

function getStoredReturnPath(): string | null {
  try {
    return safeReturnPath(window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY))
  } catch {
    return null
  }
}

function getCookieReturnPath(): string | null {
  const cookie = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${RETURN_TO_COOKIE}=`))
  if (!cookie) return null

  try {
    return safeReturnPath(decodeURIComponent(cookie.slice(RETURN_TO_COOKIE.length + 1)))
  } catch {
    return null
  }
}

function rememberReturnPath(path: string): void {
  try {
    window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, path)
  } catch {
    // Session storage can be disabled; sign-in will fall back to home.
  }
}

function clearStoredReturnPath(): void {
  try {
    window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
  document.cookie = `${RETURN_TO_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

function getSafeReturnPath(): string {
  const returnPath = getReturnPathFromUrl() ?? getStoredReturnPath() ?? getCookieReturnPath()
  return returnPath ?? '/'
}

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const urlReturnPath = getReturnPathFromUrl()
    if (urlReturnPath) rememberReturnPath(urlReturnPath)
    if (window.location.search) router.replace('/sign-in')
  }, [router])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setLoading(true)

    const returnPath = getSafeReturnPath()
    let timeout: number | null = null

    try {
      const result = await Promise.race([
        signIn('credentials', {
          email,
          password,
          redirect: false,
        }),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error(SIGN_IN_TIMEOUT_ERROR)), SIGN_IN_TIMEOUT_MS)
        }),
      ])

      if (result?.error) {
        setError('Email or password is incorrect.')
        return
      }

      clearStoredReturnPath()
      router.replace(returnPath)
      router.refresh()
    } catch (error) {
      const timedOut = error instanceof Error && error.message === SIGN_IN_TIMEOUT_ERROR
      setError(timedOut ? 'Sign-in is taking too long. Please try again.' : 'Could not sign in. Please try again.')
    } finally {
      if (timeout) window.clearTimeout(timeout)
      setLoading(false)
    }
  }

  return (
    <AuthPanel title="Sign in" subtitle="Continue to Agent 1.0.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Email</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="email"
            required
            className="h-11 w-full rounded-xl border border-border-primary bg-bg-secondary px-3.5 text-[14px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-tertiary"
            placeholder="you@example.com"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Password</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            required
            className="h-11 w-full rounded-xl border border-border-primary bg-bg-secondary px-3.5 text-[14px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-tertiary"
            placeholder="Enter your password"
          />
        </label>

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-accent-red/20 bg-accent-red/5 px-3 py-2.5 text-[12.5px] text-accent-red">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-text-primary px-4 text-[13.5px] font-semibold text-bg-primary transition-all hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
        >
          {loading ? 'Signing in' : 'Continue'}
          <ArrowRight size={14} />
        </button>
      </form>

      <p className="mt-5 text-center text-[12.5px] text-text-secondary">
        No account yet?{' '}
        <Link href="/sign-up" prefetch={false} className="font-semibold text-text-primary hover:text-accent-blue">
          Create one
        </Link>
      </p>
    </AuthPanel>
  )
}
