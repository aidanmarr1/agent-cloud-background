'use client'

import Link from 'next/link'
import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { AlertCircle, Loader2 } from '@/components/icons'

const RETURN_TO_STORAGE_KEY = 'agent-auth-return-to'
const RETURN_TO_COOKIE = 'agent-auth-return-to'
const inputClassName = 'h-11 w-full rounded-xl border border-border-primary bg-bg-secondary px-3.5 text-[14px] text-text-primary outline-none transition-colors duration-150 placeholder:text-text-muted hover:border-border-tertiary focus:border-border-tertiary focus:ring-2 focus:ring-text-muted/10 disabled:cursor-not-allowed disabled:opacity-60'

function safeReturnPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim()
  if (
    trimmed &&
    trimmed.startsWith('/') &&
    !trimmed.startsWith('//') &&
    trimmed !== '/sign-in' &&
    !trimmed.startsWith('/sign-in?') &&
    trimmed !== '/sign-up' &&
    !trimmed.startsWith('/sign-up?')
  ) return trimmed

  return null
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

function getSafeReturnPath(): string {
  return getStoredReturnPath() ?? getCookieReturnPath() ?? '/'
}

function clearStoredReturnPath(): void {
  try {
    window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
  document.cookie = `${RETURN_TO_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

export default function SignUpPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setLoading(true)

    const response = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    })
    const body = await response.json().catch(() => null) as {
      error?: string
      user?: unknown
    } | null

    if (!response.ok) {
      setError(typeof body?.error === 'string' ? body.error : 'Could not create account.')
      setLoading(false)
      return
    }

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    })

    setLoading(false)

    if (result?.error) {
      setError('Account was created, but sign-in failed. Try signing in.')
      return
    }

    const returnPath = getSafeReturnPath()
    clearStoredReturnPath()
    router.replace(returnPath)
    router.refresh()
  }

  return (
    <AuthPanel title="Create your account" subtitle="Create an account to start using Agent." dense>
      <form onSubmit={handleSubmit} className="space-y-4" aria-describedby={error ? 'sign-up-error' : undefined}>
        <label className="block">
          <span className="mb-2 flex items-center justify-between gap-3 text-[12px] font-semibold text-text-secondary">
            <span>Name</span>
            <span className="text-[10.5px] font-medium text-text-muted">Optional</span>
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            type="text"
            autoComplete="name"
            disabled={loading}
            className={inputClassName}
            placeholder="Your name"
          />
        </label>

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
          <span className="mb-2 flex items-center justify-between gap-3 text-[12px] font-semibold text-text-secondary">
            <span>Password</span>
            <span className="text-[10.5px] font-medium text-text-muted">8+ characters</span>
          </span>
          <span className="relative block">
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={8}
              required
              disabled={loading}
              aria-invalid={!!error}
              className={`${inputClassName} pr-[70px]`}
              placeholder="Create a password"
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
          <div id="sign-up-error" role="alert" className="flex items-start gap-2.5 rounded-xl border border-accent-red/20 bg-accent-red/5 px-3.5 py-3 text-[12.5px] leading-relaxed text-accent-red">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          aria-busy={loading}
          className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-text-primary px-4 text-[13.5px] font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/35 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary disabled:cursor-not-allowed disabled:opacity-55"
        >
          {loading && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-[12.5px] text-text-tertiary">
        Already have an account?{' '}
        <Link href="/sign-in" prefetch={false} className="rounded font-semibold text-text-primary transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/30">
          Sign in
        </Link>
      </p>
    </AuthPanel>
  )
}
