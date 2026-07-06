'use client'

import { useState, useRef } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { User, Settings, LogOut } from '@/components/icons'
import { useUIStore } from '@/store/ui'
import { useClickOutside } from '@/lib/useClickOutside'
import { ProfileAvatar } from './ProfileAvatar'

export function UserMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const { data: session } = useSession()
  const displayName = session?.user?.name || 'User'
  const displayEmail = session?.user?.email || 'Signed in'
  const imageUrl = session?.user?.image || null

  useClickOutside(ref, () => setOpen(false))

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-transparent bg-transparent text-text-secondary transition-all duration-200 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary"
        aria-label="User menu"
      >
        {imageUrl ? (
          <ProfileAvatar imageUrl={imageUrl} name={displayName} className="h-9 w-9 border-0" iconSize={14} />
        ) : (
          <User size={14} strokeWidth={2.25} />
        )}
      </button>

      {open && (
        <div
          className="fixed left-3 right-3 top-12 mt-2 menu-surface border border-border-primary rounded-2xl w-auto overflow-hidden z-[100] animate-scale-in sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-[260px]"
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          {/* User info */}
          <div className="px-3.5 pt-3.5 pb-3 border-b border-border-primary">
            <div className="flex items-center gap-3">
              <ProfileAvatar
                imageUrl={imageUrl}
                name={displayName}
                className="h-10 w-10 bg-bg-secondary"
                iconSize={16}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-text-primary tracking-[0] truncate">{displayName}</div>
                <div className="text-[11.5px] text-text-muted truncate mt-0.5">{displayEmail}</div>
              </div>
            </div>
          </div>

          {/* Links */}
          <div className="p-1.5">
            <button
              onClick={() => {
                setSettingsTab('general')
                setSettingsOpen(true)
                setOpen(false)
              }}
              className="w-full px-2.5 h-9 flex items-center gap-2.5 text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-all duration-150 rounded-xl"
            >
              <Settings size={13.5} className="text-current" strokeWidth={2.25} />
              Settings
              <kbd className="ml-auto text-[10px] text-text-muted font-mono font-medium bg-bg-secondary border border-border-primary rounded-md px-1.5 h-5 flex items-center tabular-nums">⌘,</kbd>
            </button>
          </div>

          <div className="border-t border-border-primary p-1.5">
            <button
              onClick={() => void signOut({ callbackUrl: '/sign-in' })}
              className="w-full px-2.5 h-9 flex items-center gap-2.5 text-[12.5px] font-medium text-accent-red hover:bg-accent-red/10 transition-all duration-150 rounded-xl"
            >
              <LogOut size={13.5} strokeWidth={2.25} />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
