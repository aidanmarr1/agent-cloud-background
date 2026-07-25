'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Tool results can briefly transition from a streaming placeholder to an
 * empty persisted value while the real result event is being reconciled.
 * Keep the loading treatment through that short hand-off so users never see
 * a false "no results" flash.
 */
export function useDeferredEmptyState(
  isEmpty: boolean,
  streaming = false,
  delayMs = 2500,
): boolean {
  const [waitingForResult, setWaitingForResult] = useState(isEmpty && streaming)
  const wasStreaming = useRef(streaming)

  useEffect(() => {
    if (!isEmpty) {
      setWaitingForResult(false)
      wasStreaming.current = streaming
      return
    }
    if (streaming) {
      wasStreaming.current = true
      setWaitingForResult(true)
      return
    }

    if (!wasStreaming.current) {
      setWaitingForResult(false)
      return
    }

    setWaitingForResult(true)
    const timeout = window.setTimeout(() => {
      wasStreaming.current = false
      setWaitingForResult(false)
    }, delayMs)
    return () => window.clearTimeout(timeout)
  }, [delayMs, isEmpty, streaming])

  return isEmpty && (streaming || waitingForResult)
}
