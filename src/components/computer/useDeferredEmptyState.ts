'use client'

import { useEffect, useState } from 'react'

/**
 * Tool results can briefly transition from a streaming placeholder to an
 * empty persisted value while the real result event is being reconciled.
 * Keep the loading treatment through that short hand-off so users never see
 * a false "no results" flash.
 */
export function useDeferredEmptyState(
  isEmpty: boolean,
  streaming = false,
  delayMs = 900,
): boolean {
  const [waitingForResult, setWaitingForResult] = useState(isEmpty)

  useEffect(() => {
    if (!isEmpty) {
      setWaitingForResult(false)
      return
    }
    if (streaming) {
      setWaitingForResult(true)
      return
    }

    setWaitingForResult(true)
    const timeout = window.setTimeout(() => setWaitingForResult(false), delayMs)
    return () => window.clearTimeout(timeout)
  }, [delayMs, isEmpty, streaming])

  return isEmpty && (streaming || waitingForResult)
}
