'use client'

import { useState, useEffect, useRef, type ChangeEvent, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { clearServerConversations, flushChatServerSync, useChatStore } from '@/store/chat'
import { clearLegacyChatPersistence } from '@/store/chat/persistence'
import { useUIStore } from '@/store/ui'
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Trash2, Upload } from '@/components/icons'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { ProfileAvatar } from '@/components/ui/ProfileAvatar'

export function DataTab() {
  const router = useRouter()
  const { data: session, update: updateSession } = useSession()
  const clearConversations = useChatStore((s) => s.clearConversations)
  const addToast = useUIStore((s) => s.addToast)
  const profileInputRef = useRef<HTMLInputElement>(null)
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(session?.user?.image || null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordFormOpen, setPasswordFormOpen] = useState(false)
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const displayName = session?.user?.name || 'User'
  const displayEmail = session?.user?.email || 'Signed in'

  useEffect(() => {
    setProfileImageUrl(session?.user?.image || null)
  }, [session?.user?.image])

  useEffect(() => {
    let active = true
    async function loadProfile() {
      const response = await fetch('/api/profile').catch(() => null)
      if (!response?.ok) return
      const body = await response.json().catch(() => null) as { user?: { image?: string | null } } | null
      if (!active) return
      if (body?.user && 'image' in body.user) {
        const image = body.user.image || null
        setProfileImageUrl(image)
        if (image !== (session?.user?.image || null)) {
          await updateSession({ user: { image } }).catch(() => undefined)
        }
      }
    }
    void loadProfile()
    return () => {
      active = false
    }
  }, [session?.user?.image, updateSession])

  const handleClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }

    setIsClearing(true)
    try {
      clearConversations()
      await clearServerConversations()
      await flushChatServerSync()
      await clearLegacyChatPersistence()
      setConfirmClear(false)
      addToast('All tasks cleared.', 'success')
      if (window.location.pathname.startsWith('/chat/')) {
        router.push('/')
      }
    } catch {
      addToast('Could not clear tasks.', 'error')
    } finally {
      setIsClearing(false)
    }
  }

  const handlePasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPasswordMessage(null)

    if (newPassword.length < 8) {
      setPasswordMessage({ type: 'error', text: 'New password must be at least 8 characters.' })
      return
    }

    if (newPassword !== confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'New passwords do not match.' })
      return
    }

    setPasswordLoading(true)
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const body = await response.json().catch(() => null)

      if (!response.ok) {
        setPasswordMessage({
          type: 'error',
          text: typeof body?.error === 'string' ? body.error : 'Could not update password.',
        })
        return
      }

      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordMessage({ type: 'success', text: 'Password updated.' })
      setPasswordFormOpen(false)
      addToast('Password updated.', 'success')
    } catch {
      setPasswordMessage({ type: 'error', text: 'Could not update password.' })
    } finally {
      setPasswordLoading(false)
    }
  }

  const updateProfileSession = async (image: string | null) => {
    setProfileImageUrl(image)
    await updateSession({ user: { image } }).catch(() => undefined)
  }

  const closePasswordForm = () => {
    setPasswordFormOpen(false)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPasswordMessage(null)
  }

  const handleProfileImageSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setProfileMessage({ type: 'error', text: 'Use a PNG, JPEG, WebP, or GIF image.' })
      return
    }

    setProfileLoading(true)
    setProfileMessage(null)
    try {
      const form = new FormData()
      form.set('image', file, file.name)
      const response = await fetch('/api/profile', {
        method: 'POST',
        body: form,
      })
      const body = await response.json().catch(() => null) as { user?: { image?: string | null }; error?: unknown } | null
      if (!response.ok) {
        const message = typeof body?.error === 'string' ? body.error : 'Could not update profile picture.'
        setProfileMessage({ type: 'error', text: message })
        return
      }
      await updateProfileSession(body?.user?.image || null)
      setProfileMessage({ type: 'success', text: 'Profile picture updated.' })
      addToast('Profile picture updated.', 'success')
    } catch {
      setProfileMessage({ type: 'error', text: 'Could not update profile picture.' })
    } finally {
      setProfileLoading(false)
    }
  }

  const handleRemoveProfileImage = async () => {
    setProfileLoading(true)
    setProfileMessage(null)
    try {
      const response = await fetch('/api/profile', { method: 'DELETE' })
      const body = await response.json().catch(() => null) as { user?: { image?: string | null }; error?: unknown } | null
      if (!response.ok) {
        const message = typeof body?.error === 'string' ? body.error : 'Could not remove profile picture.'
        setProfileMessage({ type: 'error', text: message })
        return
      }
      await updateProfileSession(body?.user?.image || null)
      setProfileMessage({ type: 'success', text: 'Profile picture removed.' })
      addToast('Profile picture removed.', 'success')
    } catch {
      setProfileMessage({ type: 'error', text: 'Could not remove profile picture.' })
    } finally {
      setProfileLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Profile</SectionLabel>
        <div className="rounded-2xl border border-border-primary bg-bg-secondary p-4">
          <input
            ref={profileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleProfileImageSelect}
          />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              <button
                type="button"
                onClick={() => profileInputRef.current?.click()}
                disabled={profileLoading}
                aria-label={profileImageUrl ? 'Change profile picture' : 'Upload profile picture'}
                className="group relative flex h-[72px] w-[72px] flex-shrink-0 items-center justify-center rounded-full transition-transform duration-150 hover:scale-[1.015] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ProfileAvatar
                  imageUrl={profileImageUrl}
                  name={displayName}
                  className="h-[72px] w-[72px] bg-bg-primary"
                  textClassName="text-[19px]"
                  iconSize={23}
                />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--overlay-profile)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                  {profileLoading ? (
                    <Loader2 size={18} className="animate-spin text-text-on-accent" strokeWidth={2.25} />
                  ) : (
                    <Upload size={18} className="text-text-on-accent" strokeWidth={2.25} />
                  )}
                </span>
                <span className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full border border-border-primary bg-bg-primary text-text-secondary shadow-sm transition-colors duration-150 group-hover:bg-bg-secondary group-hover:text-text-primary">
                  {profileLoading ? (
                    <Loader2 size={13} className="animate-spin" strokeWidth={2.25} />
                  ) : (
                    <Upload size={13} strokeWidth={2.25} />
                  )}
                </span>
              </button>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold tracking-[0] text-text-primary">{displayName}</div>
                <div className="mt-0.5 truncate text-[11.5px] text-text-muted">{displayEmail}</div>
                <div className="mt-2 inline-flex rounded-full border border-border-primary bg-bg-primary px-2 py-1 text-[10.5px] font-semibold leading-none text-text-tertiary">
                  Profile photo
                </div>
              </div>
            </div>
            <div className="flex flex-shrink-0 justify-end gap-2">
              {profileImageUrl && (
                <button
                  type="button"
                  onClick={handleRemoveProfileImage}
                  disabled={profileLoading}
                  aria-label="Remove profile picture"
                  title="Remove profile picture"
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-border-primary bg-bg-primary text-text-muted transition-colors duration-150 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 size={14} strokeWidth={2.25} />
                </button>
              )}
            </div>
          </div>
          {profileMessage && (
            <div className={`mt-3 flex items-center gap-1.5 text-[11.5px] ${
              profileMessage.type === 'success' ? 'text-text-secondary' : 'text-accent-red'
            }`}>
              {profileMessage.type === 'success'
                ? <CheckCircle2 size={13} strokeWidth={2.25} />
                : <AlertCircle size={13} strokeWidth={2.25} />
              }
              {profileMessage.text}
            </div>
          )}
        </div>
      </div>

      <div>
        <SectionLabel>Security</SectionLabel>
        <div className="overflow-hidden rounded-2xl border border-border-primary bg-bg-secondary">
          <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-primary">
                <KeyRound size={15} className="text-accent-blue" strokeWidth={2.25} />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-text-primary tracking-[0]">Password</div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-text-muted">
                  Keep your Agent account sign-in private.
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  if (passwordFormOpen) {
                    closePasswordForm()
                  } else {
                    setPasswordMessage(null)
                    setPasswordFormOpen(true)
                  }
                }}
                className="h-9 rounded-xl border border-border-primary bg-bg-primary px-3.5 text-[12px] font-semibold text-text-secondary transition-colors duration-150 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-active/35"
              >
                {passwordFormOpen ? 'Cancel' : 'Change'}
              </button>
            </div>
          </div>

          {passwordFormOpen && (
            <form onSubmit={handlePasswordChange} className="space-y-3.5 border-t border-border-primary p-4">
              <label className="block">
                <span className="mb-1.5 block text-[11.5px] font-semibold text-text-secondary">Current password</span>
                <input
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  type="password"
                  autoComplete="current-password"
                  required
                  className="h-10 w-full rounded-xl border border-border-primary bg-bg-primary px-3 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-muted hover:border-border-tertiary focus:border-accent-active/60 focus:ring-2 focus:ring-accent-active/15"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-semibold text-text-secondary">New password</span>
                  <input
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    className="h-10 w-full rounded-xl border border-border-primary bg-bg-primary px-3 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-muted hover:border-border-tertiary focus:border-accent-active/60 focus:ring-2 focus:ring-accent-active/15"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-semibold text-text-secondary">Confirm password</span>
                  <input
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    className="h-10 w-full rounded-xl border border-border-primary bg-bg-primary px-3 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-muted hover:border-border-tertiary focus:border-accent-active/60 focus:ring-2 focus:ring-accent-active/15"
                  />
                </label>
              </div>

              <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-h-5">
                  {passwordMessage && (
                    <div className={`flex items-center gap-1.5 text-[11.5px] ${
                      passwordMessage.type === 'success' ? 'text-text-secondary' : 'text-accent-red'
                    }`}>
                      {passwordMessage.type === 'success'
                        ? <CheckCircle2 size={13} strokeWidth={2.25} />
                        : <AlertCircle size={13} strokeWidth={2.25} />
                      }
                      {passwordMessage.text}
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={passwordLoading}
                  className="h-9 rounded-xl bg-text-primary px-4 text-[12px] font-semibold text-bg-primary transition-all duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-active/35 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {passwordLoading ? 'Updating...' : 'Update password'}
                </button>
              </div>
            </form>
          )}

          {!passwordFormOpen && passwordMessage && (
            <div className={`flex items-center gap-1.5 border-t border-border-primary px-4 py-3 text-[11.5px] ${
              passwordMessage.type === 'success' ? 'text-text-secondary' : 'text-accent-red'
            }`}>
              {passwordMessage.type === 'success'
                ? <CheckCircle2 size={13} strokeWidth={2.25} />
                : <AlertCircle size={13} strokeWidth={2.25} />
              }
              {passwordMessage.text}
            </div>
          )}
        </div>
      </div>

      <div>
        <SectionLabel>Task history</SectionLabel>
        <div className="rounded-2xl border border-border-primary bg-bg-secondary px-4 py-3.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-primary">
                <Trash2 size={15} className="text-[var(--danger-icon)]" strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-text-primary tracking-[0]">Clear all tasks</div>
                <div className="text-[11.5px] text-text-muted mt-0.5 leading-snug">Remove saved task history from this browser.</div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              {confirmClear && (
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="h-9 rounded-lg border border-border-primary bg-bg-primary px-3.5 text-[12px] font-semibold text-text-secondary transition-colors duration-150 hover:border-border-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={handleClearAll}
                disabled={isClearing}
                className={`h-9 rounded-lg px-3.5 text-[12px] font-semibold transition-all duration-150 ${
                  confirmClear
                    ? 'border border-[var(--danger-solid)] bg-[var(--danger-solid)] text-text-on-accent hover:bg-[var(--danger-solid-hover)]'
                    : 'border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] hover:bg-[var(--danger-bg-hover)]'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {isClearing ? 'Clearing...' : confirmClear ? 'Confirm delete' : 'Clear all'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
