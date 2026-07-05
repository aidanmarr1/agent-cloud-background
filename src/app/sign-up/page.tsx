'use client'

import Link from 'next/link'
import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { AlertCircle, ArrowRight } from '@/components/icons'

const RETURN_TO_STORAGE_KEY = 'agent-auth-return-to'
const RETURN_TO_COOKIE = 'agent-auth-return-to'

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
    <AuthPanel title="Create account" subtitle="Create your Agent 1.0 account.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            type="text"
            autoComplete="name"
            className="h-11 w-full rounded-xl border border-border-primary bg-bg-secondary px-3.5 text-[14px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-tertiary"
            placeholder="Your name"
          />
        </label>

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
            autoComplete="new-password"
            minLength={8}
            required
            className="h-11 w-full rounded-xl border border-border-primary bg-bg-secondary px-3.5 text-[14px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-tertiary"
            placeholder="At least 8 characters"
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
          {loading ? 'Creating account' : 'Create account'}
          <ArrowRight size={14} />
        </button>
      </form>

      <p className="mt-5 text-center text-[12.5px] text-text-secondary">
        Already have an account?{' '}
        <Link href="/sign-in" prefetch={false} className="font-semibold text-text-primary hover:text-accent-blue">
          Sign in
        </Link>
      </p>
    </AuthPanel>
  )
}
