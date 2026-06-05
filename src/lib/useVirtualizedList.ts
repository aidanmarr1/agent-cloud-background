'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'

interface VirtualizedListOptions {
  /** Total number of items */
  itemCount: number
  /** Unique key for each item (used for height cache) */
  getItemKey: (index: number) => string
  /** Number of items to render above/below the visible area */
  overscan?: number
  /** Number of items to always render at the end (exempt from virtualization) */
  alwaysRenderLast?: number
  /** Estimated item height for initial render before measurement */
  estimatedItemHeight?: number
  /** Set of item keys whose height should not be cached (e.g. streaming messages) */
  volatileKeys?: Set<string>
}

interface VirtualizedListResult {
  /** Start index of the virtual window (inclusive) */
  startIndex: number
  /** End index of the virtual window (exclusive, not counting alwaysRenderLast) */
  endIndex: number
  /** Total estimated height of all items in px */
  totalHeight: number
  /** Y offset for the first visible item */
  offsetTop: number
  /** Ref callback to attach to each rendered item for height measurement */
  measureRef: (index: number) => (el: HTMLElement | null) => void
  /** Ref to attach to the scroll container */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Force a re-measure of all visible items */
  invalidate: () => void
}

export function useVirtualizedList({
  itemCount,
  getItemKey,
  overscan = 3,
  alwaysRenderLast = 0,
  estimatedItemHeight = 150,
  volatileKeys,
}: VirtualizedListOptions): VirtualizedListResult {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const heightCache = useRef<Map<string, number>>(new Map())
  const elementRefs = useRef<Map<number, HTMLElement>>(new Map())
  // Bumped by invalidate() to force totalHeight recomputation after the height cache is cleared.
  const [cacheVersion, setCacheVersion] = useState(0)
  const rafId = useRef<number | null>(null)

  // Get the height of an item (cached or estimated)
  const getItemHeight = useCallback((index: number): number => {
    void cacheVersion
    const key = getItemKey(index)
    if (volatileKeys?.has(key)) {
      // For volatile items, use measured DOM height if available, else estimate
      const el = elementRefs.current.get(index)
      if (el) return el.getBoundingClientRect().height
      return estimatedItemHeight
    }
    return heightCache.current.get(key) ?? estimatedItemHeight
  }, [getItemKey, estimatedItemHeight, volatileKeys, cacheVersion])

  // Calculate cumulative offsets
  const getItemOffset = useCallback((index: number): number => {
    let offset = 0
    for (let i = 0; i < index; i++) {
      offset += getItemHeight(i)
    }
    return offset
  }, [getItemHeight])

  // Number of items in the virtualized portion (excluding alwaysRenderLast)
  const virtualizedCount = Math.max(0, itemCount - alwaysRenderLast)

  // Calculate visible range based on scroll position
  const calculateRange = useCallback((): { startIndex: number; endIndex: number } => {
    const container = containerRef.current
    if (!container || virtualizedCount === 0) {
      return { startIndex: 0, endIndex: virtualizedCount }
    }

    const scrollTop = container.scrollTop
    const viewportHeight = container.clientHeight

    // Find the first visible item using linear scan (items have variable heights)
    let accumulatedHeight = 0
    let firstVisible = 0
    for (let i = 0; i < virtualizedCount; i++) {
      const h = getItemHeight(i)
      if (accumulatedHeight + h > scrollTop) {
        firstVisible = i
        break
      }
      accumulatedHeight += h
      if (i === virtualizedCount - 1) firstVisible = virtualizedCount
    }

    // Find the last visible item
    let lastVisible = firstVisible
    let heightSoFar = accumulatedHeight
    for (let i = firstVisible; i < virtualizedCount; i++) {
      if (heightSoFar > scrollTop + viewportHeight) break
      heightSoFar += getItemHeight(i)
      lastVisible = i
    }

    const startIndex = Math.max(0, firstVisible - overscan)
    const endIndex = Math.min(virtualizedCount, lastVisible + overscan + 1)

    return { startIndex, endIndex }
  }, [virtualizedCount, getItemHeight, overscan])

  const [range, setRange] = useState(() => calculateRange())

  // Schedule range recalculation on scroll
  const recalculate = useCallback(() => {
    if (rafId.current !== null) return
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null
      const newRange = calculateRange()
      setRange(prev => {
        if (prev.startIndex === newRange.startIndex && prev.endIndex === newRange.endIndex) return prev
        return newRange
      })
    })
  }, [calculateRange])

  // Attach scroll listener
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('scroll', recalculate, { passive: true })
    // Also listen for resize
    const resizeObserver = new ResizeObserver(recalculate)
    resizeObserver.observe(container)

    return () => {
      container.removeEventListener('scroll', recalculate)
      resizeObserver.disconnect()
      if (rafId.current !== null) cancelAnimationFrame(rafId.current)
    }
  }, [recalculate])

  // Recalculate when item count changes
  useEffect(() => {
    recalculate()
  }, [itemCount, recalculate])

  // Ref callback factory for measuring items
  const measureRef = useCallback((index: number) => {
    return (el: HTMLElement | null) => {
      if (el) {
        elementRefs.current.set(index, el)
        const key = getItemKey(index)
        if (!volatileKeys?.has(key)) {
          const rect = el.getBoundingClientRect()
          const prevHeight = heightCache.current.get(key)
          if (prevHeight === undefined || Math.abs(prevHeight - rect.height) > 2) {
            heightCache.current.set(key, rect.height)
            recalculate()
          }
        }
      } else {
        elementRefs.current.delete(index)
      }
    }
  }, [getItemKey, volatileKeys, recalculate])

  // Computed values
  const totalHeight = useMemo(() => {
    let total = 0
    for (let i = 0; i < virtualizedCount; i++) {
      total += getItemHeight(i)
    }
    return total
  }, [virtualizedCount, getItemHeight])

  const offsetTop = useMemo(() => {
    return getItemOffset(range.startIndex)
  }, [range.startIndex, getItemOffset])

  const invalidate = useCallback(() => {
    heightCache.current.clear()
    setCacheVersion(n => n + 1)
    recalculate()
  }, [recalculate])

  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    totalHeight,
    offsetTop,
    measureRef,
    containerRef,
    invalidate,
  }
}
