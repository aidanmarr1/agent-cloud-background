'use client'

import Link from 'next/link'
import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { AlertCircle, Loader2 } from '@/components/icons'

const RETURN_TO_STORAGE_KEY = 'agent-auth-return-to'
const RETURN_TO_COOKIE = 'agent-auth-return-to'
const inputClassName = 'h-12 w-full rounded-xl border border-border-primary bg-bg-secondary px-3.5 text-[14px] text-text-primary outline-none transition-colors duration-150 placeholder:text-text-muted hover:border-border-tertiary focus:border-border-tertiary focus:ring-2 focus:ring-text-muted/10 disabled:cursor-not-allowed disabled:opacity-60'

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
  const [showPassword, setShowPassword] = useState(false)
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
    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    })

    setLoading(false)

    if (result?.error) {
      setError('Email or password is incorrect.')
      return
    }

    clearStoredReturnPath()
    router.replace(returnPath)
    router.refresh()
  }

  return (
    <AuthPanel title="Welcome back" subtitle="Sign in to continue to your workspace.">
      <form onSubmit={handleSubmit} className="space-y-5" aria-describedby={error ? 'sign-in-error' : undefined}>
        <label className="block">
          <span className="mb-2 block text-[12px] font-semibold text-text-secondary">Email address</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={loading}
            aria-invalid={!!error}
            className={inputClassName}
            placeholder="you@example.com"
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-[12px] font-semibold text-text-secondary">Password</span>
          <span className="relative block">
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              disabled={loading}
              aria-invalid={!!error}
              className={`${inputClassName} pr-[70px]`}
              placeholder="Enter your password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              className="absolute right-2 top-1/2 h-8 -translate-y-1/2 rounded-lg px-2.5 text-[11.5px] font-semibold text-text-tertiary transition-colors hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>

        {error && (
          <div id="sign-in-error" role="alert" className="flex items-start gap-2.5 rounded-xl border border-accent-red/20 bg-accent-red/5 px-3.5 py-3 text-[12.5px] leading-relaxed text-accent-red">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          aria-busy={loading}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-[13.5px] font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/35 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary disabled:cursor-not-allowed disabled:opacity-55"
        >
          {loading && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
          {loading ? 'Signing in…' : 'Continue'}
        </button>
      </form>

      <p className="mt-7 text-center text-[12.5px] text-text-tertiary">
        No account yet?{' '}
        <Link href="/sign-up" prefetch={false} className="rounded font-semibold text-text-primary transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/30">
          Create one
        </Link>
      </p>
    </AuthPanel>
  )
}
