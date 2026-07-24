'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useUIStore } from '@/store/ui'
import { ChatSkeleton } from '@/components/chat/ChatSkeleton'

export function MainContent({ children, initialCollapsed = false }: { children: React.ReactNode; initialCollapsed?: boolean }) {
  const pathname = usePathname()
  const sidebarCollapsed = useUIStore((s) => s.sidebarExpanded)
  const routeHandoffPending = useUIStore((s) => s.routeHandoffPending)
  const [uiHydrated, setUiHydrated] = useState(false)

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

  const collapsed = uiHydrated ? sidebarCollapsed : initialCollapsed
  const authRoute = pathname === '/sign-in' || pathname === '/sign-up'

  return (
    <main
      id="main-content"
      className={`${authRoute ? 'auth-main-content' : 'app-main-content'} flex-1 min-w-0 w-full min-h-screen ml-0 transition-[margin] duration-200 ease-out ${
        authRoute ? 'md:ml-0' : collapsed ? 'md:ml-[64px]' : 'md:ml-[260px]'
      }`}
    >
      {!authRoute && routeHandoffPending && (
        <div data-chat-route-placeholder="">
          <ChatSkeleton />
        </div>
      )}
      {children}
    </main>
  )
}
