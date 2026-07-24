'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { BarChart3, BookOpen, FileText, Keyboard, LogOut, Palette, Search, ShieldCheck, SlidersHorizontal, X } from '@/components/icons'
import { Modal } from './Modal'
import { useUIStore } from '@/store/ui'
import { ProfileAvatar } from '@/components/ui/ProfileAvatar'
import { GeneralTab } from './settings/GeneralTab'
import { InstructionsTab } from './settings/InstructionsTab'
import { AppearanceTab } from './settings/AppearanceTab'
import { DataTab } from './settings/DataTab'
import { ShortcutsTab } from './settings/ShortcutsTab'
import { SkillsTab } from './settings/SkillsTab'
import { UsageTab } from './settings/UsageTab'

const navGroups = [
  {
    label: 'Settings',
    items: [
      { id: 'general', label: 'General', description: 'Task behavior and notifications', icon: SlidersHorizontal, keywords: 'sound enter notifications behavior interface' },
      { id: 'appearance', label: 'Appearance', description: 'Theme and visual accessibility', icon: Palette, keywords: 'theme dark light system motion transparency display' },
      { id: 'account', label: 'Account & Data', description: 'Profile, security, and task history', icon: ShieldCheck, keywords: 'account profile photo password reset security clear delete tasks history' },
      { id: 'usage', label: 'Usage', description: 'Credits and task activity', icon: BarChart3, keywords: 'agent credits usage balance cost task history billing spend account' },
      { id: 'shortcuts', label: 'Shortcuts', description: 'Keyboard commands', icon: Keyboard, keywords: 'keyboard hotkeys command palette enter' },
    ],
  },
  {
    label: 'Agent',
    items: [
      { id: 'instructions', label: 'Instructions', description: 'Defaults for every task', icon: FileText, keywords: 'custom instructions prompt defaults system guidance' },
      { id: 'skills', label: 'Skills', description: 'Reusable agent capabilities', icon: BookOpen, keywords: 'skill library upload zip folder slash command' },
    ],
  },
]

const navItems = navGroups.flatMap((group) => group.items)

const tabComponents: Record<string, ComponentType> = {
  general: GeneralTab,
  instructions: InstructionsTab,
  skills: SkillsTab,
  appearance: AppearanceTab,
  shortcuts: ShortcutsTab,
  usage: UsageTab,
  account: DataTab,
}

export function SettingsModal() {
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const settingsTab = useUIStore((s) => s.settingsTab)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const [searchQuery, setSearchQuery] = useState('')
  const mobileNavRef = useRef<HTMLElement>(null)
  const { data: session } = useSession()
  const displayName = session?.user?.name || 'User'
  const accountLabel = session?.user?.email || 'Personal workspace'

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return navGroups
    return navGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalizedQuery)
        ),
      }))
      .filter((group) => group.items.length > 0)
  }, [normalizedQuery])

  const visibleItems = filteredGroups.flatMap((group) => group.items)
  const activeItem = (
    normalizedQuery && visibleItems.length > 0 && !visibleItems.some((item) => item.id === settingsTab)
      ? visibleItems[0]
      : navItems.find((item) => item.id === settingsTab)
  ) || navItems[0]
  const ActiveTab = tabComponents[activeItem.id] || GeneralTab
  useEffect(() => {
    if (!settingsOpen) return
    const frame = window.requestAnimationFrame(() => {
      mobileNavRef.current
        ?.querySelector<HTMLElement>(`[data-settings-section="${activeItem.id}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeItem.id, settingsOpen])

  const closeSettings = () => setSettingsOpen(false)

  const searchField = () => (
    <div className="relative">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
        strokeWidth={2.25}
      />
      <input
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        type="search"
        className="h-10 w-full rounded-xl border border-border-primary bg-bg-primary pl-9 pr-9 text-[12.5px] font-medium text-text-primary outline-none transition-colors duration-150 placeholder:text-text-muted hover:border-border-tertiary focus:border-border-tertiary focus:ring-2 focus:ring-accent-blue/15 [&::-webkit-search-cancel-button]:appearance-none"
        placeholder="Search settings"
        aria-label="Search settings"
      />
      {searchQuery && (
        <button
          type="button"
          onClick={() => setSearchQuery('')}
          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
          aria-label="Clear settings search"
        >
          <X size={13} strokeWidth={2.25} />
        </button>
      )}
    </div>
  )

  return (
    <Modal
      open={settingsOpen}
      onClose={closeSettings}
      ariaLabel="Settings"
      wide
      panelClassName="max-w-[1160px] h-[756px] max-h-[calc(100dvh-2rem)]"
    >
      <div className="flex h-full min-h-0 flex-col lg:flex-row">
        <div className="flex flex-shrink-0 flex-col border-b border-border-secondary bg-bg-secondary lg:hidden">
          <div className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
            <div>
              <h2 className="text-[18px] font-semibold leading-none tracking-[-0.01em] text-text-primary">Settings</h2>
              <p className="mt-1.5 text-[11.5px] text-text-tertiary">Manage your workspace and Agent</p>
            </div>
            <button
              type="button"
              onClick={closeSettings}
              aria-label="Close settings"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-primary text-text-muted transition-colors duration-150 hover:border-border-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
            >
              <X size={15} strokeWidth={2.25} />
            </button>
          </div>

          <div className="px-4 pb-3">{searchField()}</div>

          <nav ref={mobileNavRef} aria-label="Settings sections" className="scrollbar-none flex gap-2 overflow-x-auto px-4 pb-3">
            {visibleItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSettingsTab(item.id)}
                data-settings-section={item.id}
                aria-current={activeItem.id === item.id ? 'page' : undefined}
                className={`flex h-9 flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3 text-[12px] font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30 ${
                  activeItem.id === item.id
                    ? 'border-border-tertiary bg-bg-elevated text-text-primary'
                    : 'border-transparent bg-transparent text-text-secondary hover:border-border-primary hover:bg-bg-primary hover:text-text-primary'
                }`}
              >
                <item.icon
                  size={14}
                  className={activeItem.id === item.id ? 'text-accent-blue' : 'text-text-muted'}
                  strokeWidth={2.25}
                />
                {item.label}
              </button>
            ))}
            {visibleItems.length === 0 && (
              <div className="flex h-9 items-center rounded-xl border border-border-primary bg-bg-primary px-3 text-[12px] text-text-tertiary">
                No matching settings
              </div>
            )}
          </nav>
        </div>

        <aside className="hidden w-[292px] flex-shrink-0 flex-col border-r border-border-secondary bg-bg-primary lg:flex">
          <div className="px-4 pb-4 pt-5">
            <div className="flex items-center gap-3 px-1">
              <ProfileAvatar
                imageUrl={session?.user?.image}
                name={displayName}
                className="h-10 w-10"
                textClassName="text-[12px]"
                iconSize={15}
              />
              <div className="min-w-0">
                <h2 className="truncate text-[13.5px] font-semibold text-text-primary">{displayName}</h2>
                <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{accountLabel}</p>
              </div>
            </div>
            <div className="mt-5">{searchField()}</div>
          </div>

          <nav aria-label="Settings sections" className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <div className="space-y-5">
              {filteredGroups.map((group) => (
                <div key={group.label}>
                  <div className="mb-1.5 px-3 text-[11px] font-medium text-text-muted">
                    {group.label}
                  </div>
                  <div className="space-y-1">
                    {group.items.map((item) => {
                      const selected = activeItem.id === item.id
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setSettingsTab(item.id)}
                          aria-current={selected ? 'page' : undefined}
                          className={`group flex h-10 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30 ${
                            selected
                              ? 'bg-bg-tertiary text-text-primary'
                              : 'text-text-secondary hover:bg-bg-secondary hover:text-text-primary'
                          }`}
                        >
                          <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center transition-colors ${selected ? 'text-text-primary' : 'text-text-muted group-hover:text-text-secondary'}`}>
                            <item.icon size={15} strokeWidth={2.25} />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{item.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}

              {filteredGroups.length === 0 && (
                <div className="rounded-xl border border-border-primary bg-bg-primary px-3 py-4 text-center">
                  <div className="text-[12px] font-semibold text-text-secondary">No matching settings</div>
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="mt-1.5 text-[11.5px] font-medium text-accent-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
                  >
                    Clear search
                  </button>
                </div>
              )}
            </div>
          </nav>

          <div className="border-t border-border-secondary p-3">
            <button
              type="button"
              onClick={() => void signOut({ callbackUrl: '/sign-in' })}
              className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
            >
              <LogOut size={14} className="text-text-muted" strokeWidth={2.25} />
              Sign out
            </button>
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary">
          <header className="flex flex-shrink-0 items-center justify-between gap-5 border-b border-border-secondary px-5 py-5 md:px-10 md:py-8">
            <h3 className="truncate text-[24px] font-semibold leading-tight tracking-[-0.025em] text-text-primary md:text-[28px]">
              {activeItem.label}
            </h3>
            <button
              type="button"
              onClick={closeSettings}
              aria-label="Close settings"
              className="hidden h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30 lg:flex"
            >
              <X size={15} strokeWidth={2.25} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 md:px-10 md:py-8">
            <div className="mx-auto w-full max-w-[860px]">
              <ActiveTab />
            </div>
          </div>
        </main>
      </div>
    </Modal>
  )
}
