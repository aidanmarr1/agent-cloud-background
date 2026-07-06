'use client'

import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { RootOverlays } from '@/components/layout/RootOverlays'
import { MainContent } from '@/components/layout/MainContent'

const Sidebar = dynamic(
  () => import('@/components/layout/Sidebar').then((mod) => mod.Sidebar),
  { ssr: false }
)
const AUTH_ROUTES = new Set(['/sign-in', '/sign-up'])

export function AppFrame({
  children,
  initialSidebarCollapsed,
  initialSidebarKnown,
  initialAccountDeleted,
}: {
  children: React.ReactNode
  initialSidebarCollapsed: boolean
  initialSidebarKnown: boolean
  initialAccountDeleted?: boolean
}) {
  const pathname = usePathname()
  const authRoute = !!pathname && AUTH_ROUTES.has(pathname)

  if (authRoute) {
    return (
      <main id="main-content" className="app-main-content auth-main-content flex-1 min-w-0 w-full min-h-screen ml-0 md:ml-0">
        {children}
      </main>
    )
  }

  return (
    <>
      <RootOverlays
        initialAccountDeleted={initialAccountDeleted}
      />
      <Sidebar initialCollapsed={initialSidebarCollapsed} initialStateKnown={initialSidebarKnown} />
      <MainContent initialCollapsed={initialSidebarCollapsed}>
        {children}
      </MainContent>
    </>
  )
}
