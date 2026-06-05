'use client'

import {
  PenSquare,
  Settings,
  Menu,
  X,
  Search,
  Star,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  FileText,
} from '@/components/icons'
import Image from 'next/image'
import { useState, useMemo, useEffect } from 'react'
import { useUIStore } from '@/store/ui'
import { useChatStore } from '@/store/chat'
import { useRouter, usePathname } from 'next/navigation'
import type { Message } from '@/types'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

function getPreview(messages: Message[]): string {
  if (!messages.length) return ''
  const last = messages[messages.length - 1]
  const raw = last.content || ''
  return raw
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_~#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

interface SidebarProps {
  initialCollapsed?: boolean
  initialStateKnown?: boolean
}

function writeSidebarCookie(collapsed: boolean) {
  document.cookie = `agent-sidebar-collapsed=${collapsed ? '1' : '0'}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function Sidebar({ initialCollapsed = false, initialStateKnown = false }: SidebarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const mobileSidebarOpen = useUIStore((s) => s.mobileSidebarOpen)
  const setMobileSidebarOpen = useUIStore((s) => s.setMobileSidebarOpen)
  const sidebarExpanded = useUIStore((s) => s.sidebarExpanded)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setRouteHandoffPending = useUIStore((s) => s.setRouteHandoffPending)
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const setActiveId = useChatStore((s) => s.setActiveId)
  const toggleStar = useChatStore((s) => s.toggleStar)
  const [uiHydrated, setUiHydrated] = useState(false)
  const [taskQuery, setTaskQuery] = useState('')

  useEffect(() => {
    const persistApi = useUIStore.persist
    const finish = () => setUiHydrated(true)
    const unsubscribe = persistApi.onFinishHydration(finish)

    if (persistApi.hasHydrated()) {
      finish()
    } else {
      void persistApi.rehydrate()
    }

    return unsubscribe
  }, [])

  // Historical name: sidebarExpanded=true means the sidebar is collapsed.
  const collapsed = uiHydrated ? sidebarExpanded : initialCollapsed
  const showSidebarContent = uiHydrated || initialStateKnown

  useEffect(() => {
    if (!uiHydrated) return
    document.documentElement.setAttribute('data-sidebar-state', collapsed ? 'collapsed' : 'expanded')
    document.documentElement.setAttribute('data-sidebar-known', 'true')
    writeSidebarCookie(collapsed)
    document.documentElement.removeAttribute('data-ui-booting')
  }, [collapsed, uiHydrated])

  const sorted = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  )

  const filteredTasks = useMemo(() => {
    const query = taskQuery.trim().toLowerCase()
    if (!query) return sorted
    return sorted.filter((conversation) =>
      conversation.title.toLowerCase().includes(query) ||
      conversation.messages.some((message) => message.content.toLowerCase().includes(query))
    )
  }, [sorted, taskQuery])

  const openTask = (id: string) => {
    setActiveId(id)
    setRouteHandoffPending(true)
    router.push(`/chat/${id}`)
    setMobileSidebarOpen(false)
  }

  if (pathname === '/sign-in' || pathname === '/sign-up') {
    return null
  }

  const startNewTask = () => {
    setRouteHandoffPending(false)
    router.push('/')
    setMobileSidebarOpen(false)
  }

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileSidebarOpen(true)}
        className="fixed left-3 top-1.5 z-[95] flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-bg-tertiary md:hidden"
        aria-label="Open menu"
      >
        <Menu size={18} className="text-text-tertiary" />
      </button>

      {/* Mobile overlay */}
      {mobileSidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 bg-[var(--overlay-scrim-subtle)] z-[100] md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      {/* Sidebar */}
      <div
        className={`app-sidebar fixed left-0 top-0 bottom-0 overflow-hidden bg-bg-secondary border-r border-border-primary flex flex-col z-[110] transition-all duration-200 ${
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
        style={{ width: collapsed ? 56 : 256 }}
      >
        {showSidebarContent && (
          <>
            {/* Header */}
            <div className={`flex items-center ${collapsed ? 'justify-center px-0 pt-3 pb-2.5' : 'gap-2.5 px-2.5 pt-3 pb-2.5'}`}>
              <button
                className="group relative h-10 w-10 rounded-xl flex items-center justify-center border border-transparent bg-transparent flex-shrink-0 transition-colors hover:border-border-primary hover:bg-bg-secondary"
                onClick={collapsed ? toggleSidebar : startNewTask}
                aria-label={collapsed ? 'Expand sidebar' : 'Home'}
              >
                <Image
                  src="/logo.svg"
                  alt="Agent"
                  width={32}
                  height={32}
                  className={`h-8 w-8 rounded-lg object-contain transition-opacity duration-150 ${collapsed ? 'group-hover:opacity-0' : ''}`}
                />
                {collapsed && (
                  <PanelLeftOpen
                    size={16}
                    weight="regular"
                    className="absolute text-text-secondary opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                  />
                )}
              </button>
              {!collapsed && (
                <span className="text-[15px] font-semibold text-text-primary tracking-[0]">Agent</span>
              )}
              {!collapsed && (
                <button
                  onClick={toggleSidebar}
                  className="ml-auto hidden h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-secondary hover:text-text-primary md:flex"
                  aria-label="Collapse sidebar"
                >
                  <PanelLeftClose size={15} weight="regular" />
                </button>
              )}

              {/* Mobile close */}
              <button
                onClick={() => setMobileSidebarOpen(false)}
                className={`w-8 h-8 rounded-lg flex items-center justify-center hover:bg-bg-tertiary transition-colors md:hidden ${collapsed ? '' : 'ml-auto'}`}
                aria-label="Close"
              >
                <X size={16} className="text-text-tertiary" />
              </button>
            </div>

            {/* New task */}
            <div className={collapsed ? 'px-2 mb-3' : 'px-2.5 mb-3'}>
              {collapsed ? (
                <button
                  onClick={startNewTask}
                  className="w-full h-9 rounded-xl border border-transparent bg-transparent text-text-secondary flex items-center justify-center transition-all duration-150 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary active:scale-[0.98]"
                  aria-label="New task"
                >
                  <PenSquare size={15} strokeWidth={2.2} className="text-accent-blue" />
                </button>
              ) : (
                <button
                  onClick={startNewTask}
                  className="w-full h-9 rounded-xl border border-transparent bg-transparent text-text-secondary flex items-center justify-start gap-2.5 px-3 text-[12.5px] font-semibold transition-all duration-150 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary active:scale-[0.98]"
                >
                  <PenSquare size={14} strokeWidth={2.2} className="text-accent-blue" />
                  New task
                </button>
              )}
            </div>

            {/* Task search and list — hidden when collapsed */}
            {!collapsed && (
              <div className="flex min-h-0 flex-1 flex-col gap-4 px-2">
                <div className="px-1">
                  <div className="flex h-9 items-center gap-2 rounded-xl border border-border-primary bg-bg-secondary px-2.5 transition-colors focus-within:border-border-tertiary">
                    <Search size={13} className="flex-shrink-0 text-text-muted" strokeWidth={2.25} />
                    <input
                      value={taskQuery}
                      onChange={(event) => setTaskQuery(event.target.value)}
                      placeholder="Search tasks..."
                      className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-muted"
                    />
                    {taskQuery && (
                      <button
                        onClick={() => setTaskQuery('')}
                        className="flex h-5 w-5 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        aria-label="Clear search"
                      >
                        <X size={11} strokeWidth={2.25} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between px-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">
                    {taskQuery ? 'Results' : 'Tasks'}
                  </span>
                  <span className="text-[10px] text-text-muted tabular-nums">
                    {filteredTasks.length}
                  </span>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto pb-3 [scrollbar-width:thin]">
                  {filteredTasks.length === 0 ? (
                    <div className="mx-1 px-3 py-4 text-center">
                      <div className="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-lg text-text-muted">
                        <MessageSquare size={14} strokeWidth={2.2} />
                      </div>
                      <p className="text-[12.5px] font-semibold text-text-secondary">
                        {taskQuery ? 'No matches' : 'No tasks yet'}
                      </p>
                      <p className="mt-1 text-[11px] leading-snug text-text-tertiary">
                        {taskQuery ? 'Try a different search.' : 'Start a task and it will appear here.'}
                      </p>
                    </div>
                  ) : (
                    filteredTasks.map((conv) => {
                      const active = conv.id === activeId && pathname?.startsWith('/chat/')
                      const preview = getPreview(conv.messages)
                      return (
                        <div
                          key={conv.id}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openTask(conv.id)
                            }
                          }}
                          className={`group mb-0.5 flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 transition-colors ${
                            active ? 'bg-bg-secondary text-text-primary' : 'text-text-secondary hover:bg-bg-secondary'
                          }`}
                          onClick={() => openTask(conv.id)}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium">{conv.title}</div>
                            {preview && (
                              <div className="mt-0.5 truncate text-[11px] text-text-muted">{preview}</div>
                            )}
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-1">
                            <button
                              onClick={(event) => { event.stopPropagation(); toggleStar(conv.id) }}
                              className={`flex h-6 w-6 items-center justify-center rounded text-text-muted transition-all hover:text-text-primary ${
                                conv.starred ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                              }`}
                              aria-label={conv.starred ? 'Unstar' : 'Star'}
                            >
                              <Star size={12} fill={conv.starred ? 'currentColor' : 'none'} className={conv.starred ? 'text-text-secondary' : ''} />
                            </button>
                            <span className="w-6 text-right font-mono text-[10px] tabular-nums text-text-muted">
                              {relativeTime(conv.updatedAt)}
                            </span>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {/* Spacer when collapsed */}
            {collapsed && <div className="flex-1" />}

            {/* Bottom actions */}
            <div className={`border-t border-border-primary py-3 flex ${collapsed ? 'flex-col items-center justify-center gap-1 px-2' : 'items-center gap-1.5 px-2.5'}`}>
              {collapsed ? (
                <button
                  onClick={() => {
                    setSettingsTab('instructions')
                    setSettingsOpen(true)
                    setMobileSidebarOpen(false)
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                  aria-label="Personalisation"
                  title="Personalisation"
                >
                  <FileText size={16} weight="regular" />
                </button>
              ) : (
                <button
                  onClick={() => {
                    setSettingsTab('instructions')
                    setSettingsOpen(true)
                    setMobileSidebarOpen(false)
                  }}
                  className="flex h-9 flex-1 items-center justify-center gap-2 rounded-xl px-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                  aria-label="Personalisation"
                >
                  <FileText size={15} weight="regular" className="text-text-muted" />
                  <span className="truncate">Personalise</span>
                </button>
              )}
              {collapsed ? (
                <button
                  onClick={() => {
                    setSettingsTab('general')
                    setSettingsOpen(true)
                    setMobileSidebarOpen(false)
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                  aria-label="Settings"
                >
                  <Settings size={16} weight="regular" />
                </button>
              ) : (
                <button
                  onClick={() => {
                    setSettingsTab('general')
                    setSettingsOpen(true)
                    setMobileSidebarOpen(false)
                  }}
                  className="flex h-9 flex-1 items-center justify-center gap-2 rounded-xl px-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                  aria-label="Settings"
                >
                  <Settings size={15} weight="regular" className="text-text-muted" />
                  <span>Settings</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}
