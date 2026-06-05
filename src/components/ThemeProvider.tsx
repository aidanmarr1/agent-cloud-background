'use client'

import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/store/settings'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSettingsStore((s) => s.theme)
  const reduceMotion = useSettingsStore((s) => s.reduceMotion)
  const reduceTransparency = useSettingsStore((s) => s.reduceTransparency)
  const [hydrated, setHydrated] = useState(false)
  const appliedOnce = useRef(false)

  useEffect(() => {
    const persistApi = useSettingsStore.persist
    if (!persistApi) {
      setHydrated(true)
      return
    }
    if (persistApi.hasHydrated()) {
      setHydrated(true)
      return
    }
    const unsub = persistApi.onFinishHydration(() => setHydrated(true))
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const root = document.documentElement

    let transitionTimer: ReturnType<typeof setTimeout> | undefined
    if (appliedOnce.current && !reduceMotion) {
      // Add smooth transition only for user-initiated theme changes, not first paint.
      root.style.transition = 'background-color 0.3s, color 0.3s'
      transitionTimer = setTimeout(() => {
        root.style.transition = ''
      }, 300)
    }
    appliedOnce.current = true

    const applyTheme = (mode: 'light' | 'dark') => {
      root.classList.remove('light', 'dark')
      root.classList.add(mode)
      root.style.colorScheme = mode
    }

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const apply = (dark: boolean) => {
        applyTheme(dark ? 'dark' : 'light')
      }
      apply(mq.matches)
      const handler = (e: MediaQueryListEvent) => apply(e.matches)
      mq.addEventListener('change', handler)
      return () => {
        mq.removeEventListener('change', handler)
        if (transitionTimer !== undefined) clearTimeout(transitionTimer)
      }
    } else {
      applyTheme(theme === 'dark' ? 'dark' : 'light')
      return () => {
        if (transitionTimer !== undefined) clearTimeout(transitionTimer)
      }
    }
  }, [hydrated, theme, reduceMotion])

  useEffect(() => {
    document.documentElement.removeAttribute('data-font-size')
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const root = document.documentElement
    root.toggleAttribute('data-reduce-motion', reduceMotion)
    root.toggleAttribute('data-reduce-transparency', reduceTransparency)
  }, [hydrated, reduceMotion, reduceTransparency])

  return <>{children}</>
}
