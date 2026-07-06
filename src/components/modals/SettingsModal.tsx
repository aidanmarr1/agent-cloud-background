'use client'

import { useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { BarChart3, BookOpen, ChevronDown, FileText, Keyboard, LogOut, Palette, Search, ShieldCheck, SlidersHorizontal, X } from '@/components/icons'
import { Modal } from './Modal'
import { useUIStore } from '@/store/ui'
import { CustomSelect } from '@/components/ui/CustomSelect'
import { ProfileAvatar } from '@/components/ui/ProfileAvatar'
import { useClickOutside } from '@/lib/useClickOutside'
import { GeneralTab } from './settings/GeneralTab'
import { InstructionsTab } from './settings/InstructionsTab'
import { AppearanceTab } from './settings/AppearanceTab'
import { DataTab } from './settings/DataTab'
import { ShortcutsTab } from './settings/ShortcutsTab'
import { SkillsTab } from './settings/SkillsTab'
import { UsageTab } from './settings/UsageTab'

const navGroups = [
  {
    label: 'Account',
    items: [
      { id: 'account', label: 'Account & Data', description: 'Profile, password, and task history', icon: ShieldCheck, keywords: 'account profile photo password reset security clear delete tasks history' },
      { id: 'general', label: 'General', description: 'Task behavior and defaults', icon: SlidersHorizontal, keywords: 'language sound enter notifications behavior interface' },
      { id: 'usage', label: 'Usage', description: 'Spend and task credit history', icon: BarChart3, keywords: 'agent credits usage balance cost task history billing spend account' },
      { id: 'appearance', label: 'Appearance', description: 'Theme and display', icon: Palette, keywords: 'theme dark light system motion transparency display' },
      { id: 'shortcuts', label: 'Shortcuts', description: 'Keyboard commands', icon: Keyboard, keywords: 'keyboard hotkeys command palette enter' },
    ],
  },
  {
    label: 'Agent',
    items: [
      { id: 'instructions', label: 'Instructions', description: 'Defaults for every task', icon: FileText, keywords: 'custom instructions prompt defaults system guidance' },
      { id: 'skills', label: 'Skills', description: 'Reusable agent skills', icon: BookOpen, keywords: 'skill library upload zip folder slash command' },
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const { data: session } = useSession()
  const displayName = session?.user?.name || 'User'
  const accountLabel = 'Personal workspace'

  useClickOutside(accountMenuRef, () => setAccountMenuOpen(false))

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
  const ActiveIcon = activeItem.icon
  const mobileSectionOptions = visibleItems.map((item) => ({ value: item.id, label: item.label }))

  return (
    <Modal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      wide
      panelClassName="max-w-[1120px] h-[720px] max-h-[92vh]"
    >
      <div className="relative flex h-full min-h-0 flex-col md:flex-row">
        <button
          type="button"
          onClick={() => setSettingsOpen(false)}
          aria-label="Close dialog"
          data-no-focus-ring
          className="absolute right-5 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-tertiary"
        >
          <X size={15} strokeWidth={2.25} />
        </button>

        <nav
          aria-label="Settings sections"
          className="flex flex-shrink-0 flex-col gap-2.5 border-b border-border-secondary bg-bg-primary p-4 md:w-[300px] md:border-b-0 md:border-r md:p-5"
        >
          <div ref={accountMenuRef} className="relative hidden border-b border-border-secondary pb-4 md:block">
            <button
              type="button"
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-expanded={accountMenuOpen}
              aria-haspopup="menu"
              className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors duration-150 hover:bg-bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30"
            >
              <ProfileAvatar
                imageUrl={session?.user?.image}
                name={displayName}
                className="h-11 w-11"
                textClassName="text-[14px]"
                iconSize={17}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-text-primary tracking-[0]">{displayName}</div>
                <div className="mt-0.5 truncate text-[12px] font-medium text-text-tertiary">{accountLabel}</div>
              </div>
              <ChevronDown
                size={15}
                className={`flex-shrink-0 text-text-muted transition-transform duration-150 ${accountMenuOpen ? 'rotate-180' : ''}`}
                strokeWidth={2.25}
              />
            </button>

            {accountMenuOpen && (
              <div
                className="absolute left-0 right-0 top-[calc(100%-0.5rem)] z-30 overflow-hidden rounded-2xl border border-border-primary menu-surface p-1.5 animate-scale-in origin-top"
                style={{ boxShadow: 'var(--shadow-lg)' }}
                role="menu"
              >
                <button
                  type="button"
                  onClick={() => {
                    setSettingsTab('account')
                    setAccountMenuOpen(false)
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[12.5px] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary"
                  role="menuitem"
                >
                  <ShieldCheck size={14} className="text-text-muted" strokeWidth={2.25} />
                  Account & Data
                </button>
                <button
                  type="button"
                  onClick={() => void signOut({ callbackUrl: '/sign-in' })}
                  className="flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[12.5px] font-medium text-accent-red transition-colors duration-150 hover:bg-accent-red/10"
                  role="menuitem"
                >
                  <LogOut size={14} strokeWidth={2.25} />
                  Sign out
                </button>
              </div>
            )}
          </div>

          <div className="relative flex-shrink-0">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              strokeWidth={2.25}
            />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-9 w-full rounded-xl border border-border-primary bg-bg-secondary pl-9 pr-3 text-[12.5px] font-medium text-text-primary outline-none transition-colors duration-150 placeholder:text-text-muted hover:border-border-tertiary focus:border-border-primary focus:ring-2 focus:ring-accent-blue/15"
              placeholder="Search settings"
              aria-label="Search settings"
            />
          </div>

          <div className="md:hidden">
            {visibleItems.length > 0 ? (
              <CustomSelect
                value={activeItem.id}
                onChange={setSettingsTab}
                options={mobileSectionOptions}
                label="Settings section"
                className="h-9 text-[12.5px]"
              />
            ) : (
              <div className="rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-[12px] text-text-tertiary">
                No matching settings
              </div>
            )}
          </div>

          <div className="hidden min-h-0 flex-1 flex-col gap-3 overflow-y-auto md:flex">
            {filteredGroups.map((group) => (
              <div key={group.label} className="flex flex-col gap-1.5">
                <div className="px-1">
                  <div className="text-[12px] font-semibold text-text-tertiary">
                    {group.label}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSettingsTab(item.id)}
                      aria-current={activeItem.id === item.id ? 'page' : undefined}
                      className={`group flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30 ${
                        activeItem.id === item.id
                          ? 'bg-bg-secondary text-text-primary'
                          : 'text-text-secondary hover:bg-bg-secondary hover:text-text-primary'
                      }`}
                    >
                      <item.icon
                        size={17}
                        className={`flex-shrink-0 ${activeItem.id === item.id ? 'text-text-primary' : 'text-text-muted group-hover:text-text-secondary'}`}
                        strokeWidth={2.25}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {filteredGroups.length === 0 && (
              <div className="rounded-lg border border-border-primary bg-bg-secondary px-3 py-2 text-[12px] text-text-tertiary">
                No matching settings
              </div>
            )}
          </div>
        </nav>

        <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
          <div className="border-b border-border-secondary px-5 pb-5 pt-6 md:px-9 md:pb-6 md:pt-10">
            <div className="flex items-center gap-3 md:hidden">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary">
                <ActiveIcon size={15} className="text-accent-blue" strokeWidth={2.25} />
              </div>
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-text-primary tracking-[0]">{activeItem.label}</div>
                <div className="mt-0.5 truncate text-[11.5px] text-text-secondary">{activeItem.description}</div>
              </div>
            </div>
            <div className="hidden md:block">
              <h2 className="text-[30px] font-semibold leading-tight tracking-[0] text-text-primary">{activeItem.label}</h2>
              <p className="mt-2 text-[13px] font-medium text-text-tertiary">{activeItem.description}</p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5 md:px-9 md:py-7">
            <div className="w-full max-w-[780px]">
              <ActiveTab />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
