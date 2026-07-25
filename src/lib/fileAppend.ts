const MIN_REPLAYED_APPEND_OVERLAP_CHARS = 120
const MAX_REPLAYED_APPEND_OVERLAP_CHARS = 32_000

/**
 * Interrupted provider streams can replay the tail of a recovered file when
 * the continuation call starts. Remove only an exact suffix/prefix overlap;
 * ordinary repeated headings or intentionally similar prose remain untouched.
 */
export function trimReplayedAppendOverlap(existing: string, incoming: string): string {
  if (!existing || !incoming) return incoming

  const maxOverlap = Math.min(
    existing.length,
    incoming.length,
    MAX_REPLAYED_APPEND_OVERLAP_CHARS,
  )
  if (maxOverlap < MIN_REPLAYED_APPEND_OVERLAP_CHARS) return incoming

  const existingTail = existing.slice(-maxOverlap)
  for (let overlap = maxOverlap; overlap >= MIN_REPLAYED_APPEND_OVERLAP_CHARS; overlap--) {
    if (existingTail.endsWith(incoming.slice(0, overlap))) {
      return incoming.slice(overlap)
    }
  }

  return incoming
}
