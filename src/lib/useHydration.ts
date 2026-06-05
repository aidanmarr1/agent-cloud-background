'use client'

import { useState, useEffect } from 'react'
import { isStoreHydrated, onStoreHydrated } from '@/lib/storeHydration'

export function useHydration() {
  const [hydrated, setHydrated] = useState(() => isStoreHydrated())

  useEffect(() => {
    if (isStoreHydrated()) {
      setHydrated(true)
      return
    }
    const unsub = onStoreHydrated(() => setHydrated(true))

    return () => {
      unsub()
    }
  }, [])

  return hydrated
}
