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
  Bot,
} from '@/components/icons'
import { useState, useMemo, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { useUIStore } from '@/store/ui'
import { useChatStore } from '@/store/chat'
import { useRouter, usePathname } from 'next/navigation'
import type { Conversation } from '@/types'

interface ConversationGroup {
  label: 'Starred' | 'Today' | 'Earlier' | 'Results'
  conversations: Conversation[]
}

function groupConversations(conversations: Conversation[], searching: boolean): ConversationGroup[] {
  if (searching) {
    return [{ label: 'Results', conversations }]
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const groups: ConversationGroup[] = [
    { label: 'Starred', conversations: [] },
    { label: 'Today', conversations: [] },
    { label: 'Earlier', conversations: [] },
  ]

  for (const conversation of conversations) {
    if (conversation.starred) {
      groups[0].conversations.push(conversation)
    } else if (conversation.updatedAt >= today.getTime()) {
      groups[1].conversations.push(conversation)
    } else {
      groups[2].conversations.push(conversation)
    }
  }

  return groups.filter((group) => group.conversations.length > 0)
}

interface SidebarProps {
  initialCollapsed?: boolean
  initialStateKnown?: boolean
}

function CollapsedSidebarLabel({ children }: { children: ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-[140] -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-[10px] bg-[var(--tooltip-surface)] px-3 py-2 text-[12.5px] font-medium text-[var(--tooltip-text)] opacity-0 shadow-lg transition-[opacity,transform] duration-75 group-hover/sidebar-label:translate-x-0 group-hover/sidebar-label:opacity-100 group-focus-within/sidebar-label:translate-x-0 group-focus-within/sidebar-label:opacity-100"
    >
      {children}
    </span>
  )
}

function writeSidebarCookie(collapsed: boolean) {
  document.cookie = `agent-sidebar-collapsed=${collapsed ? '1' : '0'}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function Sidebar({ initialCollapsed = false, initialStateKnown = false }: SidebarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen)
  const setSettingsTab = useUIStore((state) => state.setSettingsTab)
  const mobileSidebarOpen = useUIStore((state) => state.mobileSidebarOpen)
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen)
  const sidebarExpanded = useUIStore((state) => state.sidebarExpanded)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)
  const isStreaming = useUIStore((state) => state.isStreaming)
  const setRouteHandoffPending = useUIStore((state) => state.setRouteHandoffPending)
  const conversations = useChatStore((state) => state.conversations)
  const activeId = useChatStore((state) => state.activeId)
  const setActiveId = useChatStore((state) => state.setActiveId)
  const toggleStar = useChatStore((state) => state.toggleStar)
  const [uiHydrated, setUiHydrated] = useState(false)
  const [taskQuery, setTaskQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [focusSearchAfterExpand, setFocusSearchAfterExpand] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null)

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
  const renderCollapsed = collapsed && !mobileSidebarOpen
  const showSidebarContent = uiHydrated || initialStateKnown

  const closeMobileSidebar = useCallback((restoreFocus = true) => {
    setMobileSidebarOpen(false)
    if (restoreFocus) {
      window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus())
    }
  }, [setMobileSidebarOpen])

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 768px)')

    const handleViewportChange = () => {
      setIsMobileViewport(!desktopQuery.matches)
      if (desktopQuery.matches) setMobileSidebarOpen(false)
    }

    handleViewportChange()
    desktopQuery.addEventListener('change', handleViewportChange)
    return () => desktopQuery.removeEventListener('change', handleViewportChange)
  }, [setMobileSidebarOpen])

  useEffect(() => {
    if (!mobileSidebarOpen || !isMobileViewport) return

    const sidebar = sidebarRef.current
    const mainContent = document.getElementById('main-content')
    const mainWasInert = mainContent?.hasAttribute('inert') ?? false
    const previousAriaHidden = mainContent?.getAttribute('aria-hidden')
    const previousBodyOverflow = document.body.style.overflow

    mainContent?.setAttribute('inert', '')
    mainContent?.setAttribute('aria-hidden', 'true')
    document.body.style.overflow = 'hidden'

    const focusFrame = window.requestAnimationFrame(() => mobileCloseButtonRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMobileSidebar()
        return
      }

      if (event.key !== 'Tab' || !sidebar) return

      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute('inert'))

      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousBodyOverflow

      if (!mainWasInert) mainContent?.removeAttribute('inert')
      if (previousAriaHidden === null || previousAriaHidden === undefined) {
        mainContent?.removeAttribute('aria-hidden')
      } else {
        mainContent?.setAttribute('aria-hidden', previousAriaHidden)
      }
    }
  }, [closeMobileSidebar, isMobileViewport, mobileSidebarOpen])

  useEffect(() => {
    if (!focusSearchAfterExpand || renderCollapsed) return

    const focusFrame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      setFocusSearchAfterExpand(false)
    })

    return () => window.cancelAnimationFrame(focusFrame)
  }, [focusSearchAfterExpand, renderCollapsed])

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

  const searching = taskQuery.trim().length > 0
  const groupedTasks = useMemo(
    () => groupConversations(filteredTasks, searching),
    [filteredTasks, searching]
  )

  const openTask = (id: string) => {
    setActiveId(id)
    setRouteHandoffPending(true)
    router.push(`/chat/${id}`)
    setMobileSidebarOpen(false)
  }

  const startNewTask = () => {
    setRouteHandoffPending(false)
    router.push('/')
    setMobileSidebarOpen(false)
  }

  const openSettings = () => {
    setSettingsTab('general')
    setSettingsOpen(true)
    setMobileSidebarOpen(false)
  }

  const expandAndSearch = () => {
    setSearchOpen(true)
    setFocusSearchAfterExpand(true)
    toggleSidebar()
  }

  const collapseSidebar = () => {
    setSearchOpen(false)
    setTaskQuery('')
    toggleSidebar()
  }

  if (pathname === '/sign-in' || pathname === '/sign-up') {
    return null
  }

  return (
    <>
      <button
        ref={mobileMenuButtonRef}
        type="button"
        onClick={() => setMobileSidebarOpen(true)}
        className={`fixed left-2.5 top-2.5 z-[95] flex h-10 w-10 items-center justify-center rounded-lg border border-border-primary bg-bg-elevated text-text-secondary shadow-sm transition-colors hover:bg-bg-card hover:text-text-primary md:hidden ${
          mobileSidebarOpen ? 'pointer-events-none opacity-0' : ''
        }`}
        aria-label="Open menu"
        aria-controls="app-sidebar"
        aria-expanded={mobileSidebarOpen}
        aria-hidden={mobileSidebarOpen ? true : undefined}
        tabIndex={mobileSidebarOpen ? -1 : 0}
      >
        <Menu size={19} />
      </button>

      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-[100] bg-[var(--overlay-scrim-subtle)] md:hidden"
          onClick={() => closeMobileSidebar()}
          aria-hidden="true"
        />
      )}

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        role={isMobileViewport ? 'dialog' : 'navigation'}
        aria-label="Task navigation"
        aria-modal={isMobileViewport && mobileSidebarOpen ? true : undefined}
        aria-hidden={isMobileViewport && !mobileSidebarOpen ? true : undefined}
        inert={isMobileViewport && !mobileSidebarOpen ? true : undefined}
        className={`app-sidebar fixed inset-y-0 left-0 z-[110] flex flex-col overflow-visible border-r border-[var(--sidebar-divider)] bg-[var(--sidebar-surface)] transition-[width,transform] duration-200 ease-out ${
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
        style={{ width: renderCollapsed ? 64 : 260 }}
      >
        {showSidebarContent && (
          <>
            <header className="flex h-14 flex-shrink-0 items-center px-3">
              {renderCollapsed ? (
                <div className="group/sidebar-toggle relative flex h-10 w-10 flex-shrink-0 items-center justify-center">
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    className="flex h-10 w-10 items-center justify-center rounded-lg text-text-primary transition-colors duration-100 hover:bg-[var(--sidebar-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/35"
                    aria-label="Open sidebar"
                    aria-expanded={false}
                    aria-describedby="sidebar-toggle-tooltip"
                    data-no-focus-ring=""
                  >
                    <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center text-text-primary">
                      <Bot
                        size={24}
                        weight="regular"
                        aria-hidden="true"
                        className="absolute transition-[opacity,transform] duration-75 ease-out group-hover/sidebar-toggle:scale-90 group-hover/sidebar-toggle:opacity-0"
                      />
                      <PanelLeftOpen
                        size={19}
                        weight="regular"
                        aria-hidden="true"
                        className="absolute scale-90 opacity-0 transition-[opacity,transform] duration-75 ease-out group-hover/sidebar-toggle:scale-100 group-hover/sidebar-toggle:opacity-100"
                      />
                    </span>
                  </button>
                  <span
                    id="sidebar-toggle-tooltip"
                    role="tooltip"
                    className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-[140] flex -translate-y-1/2 translate-x-1 items-center gap-2 whitespace-nowrap rounded-[10px] bg-[var(--tooltip-surface)] px-3 py-2 text-[12.5px] font-medium text-[var(--tooltip-text)] opacity-0 shadow-lg transition-[opacity,transform] duration-75 group-hover/sidebar-toggle:translate-x-0 group-hover/sidebar-toggle:opacity-100 group-focus-within/sidebar-toggle:translate-x-0 group-focus-within/sidebar-toggle:opacity-100"
                  >
                    Open sidebar
                    <kbd className="font-mono text-[10.5px] font-medium text-[var(--tooltip-muted)]">⌘⇧E</kbd>
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center text-text-primary" aria-hidden="true">
                    <Bot size={24} weight="regular" />
                  </div>
                  <span className="ml-2 min-w-0 max-w-[92px] truncate text-[18px] font-normal tracking-[-0.02em] [font-family:var(--font-display)]">
                    Agent
                  </span>

                  <div className="ml-auto hidden items-center gap-0.5 md:flex">
                    <div className="group/header-search relative">
                      <button
                        type="button"
                        onClick={() => {
                          setSearchOpen(true)
                          setFocusSearchAfterExpand(true)
                        }}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors duration-100 hover:bg-[var(--sidebar-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/35"
                        aria-label="Search tasks"
                      >
                        <Search size={18} strokeWidth={2} />
                      </button>
                      <span
                        role="tooltip"
                        className="pointer-events-none absolute right-0 top-[calc(100%+7px)] z-[140] translate-y-1 whitespace-nowrap rounded-[10px] bg-[var(--tooltip-surface)] px-3 py-2 text-[12.5px] font-medium text-[var(--tooltip-text)] opacity-0 shadow-lg transition-[opacity,transform] duration-75 group-hover/header-search:translate-y-0 group-hover/header-search:opacity-100 group-focus-within/header-search:translate-y-0 group-focus-within/header-search:opacity-100"
                      >
                        Search
                      </span>
                    </div>
                    <div className="group/header-toggle relative">
                      <button
                        type="button"
                        onClick={collapseSidebar}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors duration-100 hover:bg-[var(--sidebar-hover)] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-muted/35"
                        aria-label="Close sidebar"
                        aria-expanded={true}
                      >
                        <PanelLeftClose size={19} weight="regular" />
                      </button>
                      <span
                        role="tooltip"
                        className="pointer-events-none absolute right-0 top-[calc(100%+7px)] z-[140] translate-y-1 whitespace-nowrap rounded-[10px] bg-[var(--tooltip-surface)] px-3 py-2 text-[12.5px] font-medium text-[var(--tooltip-text)] opacity-0 shadow-lg transition-[opacity,transform] duration-75 group-hover/header-toggle:translate-y-0 group-hover/header-toggle:opacity-100 group-focus-within/header-toggle:translate-y-0 group-focus-within/header-toggle:opacity-100"
                      >
                        Close sidebar
                      </span>
                    </div>
                  </div>
                </>
              )}

              <button
                ref={mobileCloseButtonRef}
                type="button"
                onClick={() => closeMobileSidebar()}
                className="ml-auto flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-[var(--sidebar-hover)] hover:text-text-primary md:hidden"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
            </header>

            <div className={renderCollapsed ? 'group/sidebar-label relative mx-3' : 'px-3'}>
              <button
                type="button"
                onClick={startNewTask}
                className="flex h-10 w-full items-center overflow-hidden rounded-lg font-medium text-text-secondary transition-colors duration-150 hover:bg-[var(--sidebar-hover)] hover:text-text-primary"
                aria-label="New task"
              >
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center">
                  <PenSquare size={16} strokeWidth={2.1} />
                </span>
                <span
                  aria-hidden={renderCollapsed ? true : undefined}
                  className={`whitespace-nowrap text-[12.5px] transition-[opacity,transform] duration-200 ease-out ${
                    renderCollapsed
                      ? '-translate-x-1 opacity-0'
                      : 'translate-x-0 opacity-100'
                  }`}
                >
                  New task
                </span>
              </button>
              {renderCollapsed && <CollapsedSidebarLabel>New task</CollapsedSidebarLabel>}
            </div>

            {renderCollapsed ? (
              <div className="mt-2 flex flex-col items-center gap-1 px-3.5">
                <div className="group/sidebar-label relative">
                  <button
                    type="button"
                    onClick={expandAndSearch}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-[var(--sidebar-hover)] hover:text-text-primary"
                    aria-label="Expand sidebar and search tasks"
                  >
                    <Search size={16} strokeWidth={2} />
                  </button>
                  <CollapsedSidebarLabel>Search</CollapsedSidebarLabel>
                </div>
              </div>
            ) : (
              <div className="mt-2.5 flex min-h-0 flex-1 flex-col">
                {searchOpen && (
                  <div className="px-3 animate-fade-in">
                    <div className="flex h-9 items-center gap-2.5 rounded-lg border border-transparent bg-[var(--sidebar-field)] px-3 text-text-muted transition-[border-color,color] focus-within:border-border-tertiary focus-within:text-text-secondary">
                      <Search size={15} className="flex-shrink-0" strokeWidth={2} />
                      <input
                        ref={searchInputRef}
                        value={taskQuery}
                        onChange={(event) => setTaskQuery(event.target.value)}
                        placeholder="Search tasks"
                        aria-label="Search tasks"
                        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-muted"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setTaskQuery('')
                          setSearchOpen(false)
                        }}
                        className="-mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-[var(--sidebar-hover)] hover:text-text-primary"
                        aria-label="Close search"
                      >
                        <X size={13} strokeWidth={2.25} />
                      </button>
                    </div>
                    <p className="sr-only" aria-live="polite">
                      {searching ? `${filteredTasks.length} tasks found` : `${filteredTasks.length} tasks`}
                    </p>
                  </div>
                )}

                <div className={`${searchOpen ? 'mt-4' : 'mt-1.5'} min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 [scrollbar-width:thin]`}>
                  {filteredTasks.length === 0 ? (
                    <div className="mx-1.5 mt-4 px-4 py-6 text-center">
                      <span className="mx-auto flex h-9 w-9 items-center justify-center text-text-muted">
                        {searching ? <Search size={17} /> : <PenSquare size={17} />}
                      </span>
                      <p className="mt-3 text-[13px] font-semibold text-text-primary">
                        {searching ? 'No tasks found' : 'Your tasks will live here'}
                      </p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
                        {searching
                          ? 'Try a different word or search.'
                          : 'Start something new and come back to it anytime.'}
                      </p>
                      {searching && (
                        <button
                          type="button"
                          onClick={() => setTaskQuery('')}
                          className="mt-3 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-[var(--sidebar-hover)] hover:text-text-primary"
                        >
                          Clear search
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {groupedTasks.map((group) => {
                        const headingId = `sidebar-${group.label.toLowerCase()}`

                        return (
                          <section key={group.label} aria-labelledby={headingId}>
                            <h2
                              id={headingId}
                              className="mb-1.5 px-2.5 text-[11.5px] font-semibold text-text-tertiary"
                            >
                              {group.label}
                            </h2>
                            <div role="list" aria-labelledby={headingId} className="space-y-1">
                              {group.conversations.map((conversation) => {
                                const active = conversation.id === activeId && pathname?.startsWith('/chat/')
                                const running = conversation.id === activeId && isStreaming

                                return (
                                  <div
                                    key={conversation.id}
                                    role="listitem"
                                    className={`group flex min-h-[42px] items-stretch overflow-hidden rounded-lg transition-colors ${
                                      active
                                        ? 'bg-[var(--sidebar-selected)]'
                                        : 'hover:bg-[var(--sidebar-hover)]'
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => openTask(conversation.id)}
                                      className="min-w-0 flex-1 px-3 py-2.5 text-left"
                                      aria-current={active ? 'page' : undefined}
                                      aria-label={`${running ? 'Working on' : 'Open task'}: ${conversation.title}`}
                                    >
                                      <span
                                        className={`block truncate text-[13px] leading-5 text-text-primary ${
                                          active ? 'font-semibold' : 'font-medium'
                                        }`}
                                      >
                                        {conversation.title}
                                      </span>
                                      {running && (
                                        <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] font-medium text-status-live">
                                          <span
                                            className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-status-live animate-live-pulse"
                                            aria-hidden="true"
                                          />
                                          Working
                                        </span>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => toggleStar(conversation.id)}
                                      className={`my-1.5 mr-1.5 flex w-8 flex-shrink-0 items-center justify-center rounded-lg transition-[background-color,color,opacity] hover:bg-[var(--sidebar-field)] hover:text-text-primary focus-visible:pointer-events-auto focus-visible:opacity-100 ${
                                        conversation.starred
                                          ? 'text-text-secondary opacity-100'
                                          : 'text-text-muted opacity-100 md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'
                                      }`}
                                      aria-label={`${conversation.starred ? 'Remove from starred' : 'Add to starred'}: ${conversation.title}`}
                                      aria-pressed={conversation.starred}
                                      title={conversation.starred ? 'Remove from starred' : 'Add to starred'}
                                    >
                                      <Star
                                        size={15}
                                        fill={conversation.starred ? 'currentColor' : 'none'}
                                      />
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          </section>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {renderCollapsed && <div className="flex-1" />}

            <footer className={renderCollapsed ? 'group/sidebar-label relative mx-3 mb-3 mt-3 flex-shrink-0' : 'flex-shrink-0 p-3'}>
              <button
                type="button"
                onClick={openSettings}
                className="flex h-10 w-full items-center overflow-hidden rounded-lg text-text-secondary transition-colors hover:bg-[var(--sidebar-hover)] hover:text-text-primary"
                aria-label="Settings"
              >
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center">
                  <Settings size={16} weight="regular" className="text-text-muted" />
                </span>
                <span
                  aria-hidden={renderCollapsed ? true : undefined}
                  className={`whitespace-nowrap text-[12.5px] font-medium transition-[opacity,transform] duration-200 ease-out ${
                    renderCollapsed
                      ? '-translate-x-1 opacity-0'
                      : 'translate-x-0 opacity-100'
                  }`}
                >
                  Settings
                </span>
              </button>
              {renderCollapsed && <CollapsedSidebarLabel>Settings</CollapsedSidebarLabel>}
            </footer>
          </>
        )}
      </aside>
    </>
  )
}
