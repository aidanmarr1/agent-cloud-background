export interface BrowseLoadingState {
  itemStreaming?: boolean
  itemEmpty: boolean
  itemTitle?: string
  taskStreaming: boolean
  activeItemId?: string
  latestItemId?: string
}

function isInFlightBrowsePlaceholder(title: string | undefined): boolean {
  const normalized = title?.trim() || ''
  return /^Reading document(?:\.{3}|…)?$/i.test(normalized) ||
    /^Fetching\s+.+(?:\.{3}|…)$/i.test(normalized)
}

/**
 * Conversation persistence intentionally removes transient `streaming` flags.
 * While a task is still live, retain loading only for the newest empty browse
 * placeholder whose title still identifies an in-flight extraction. Completed
 * empty/failure results receive a different title and remain honest failures.
 */
export function isBrowseResultPending({
  itemStreaming,
  itemEmpty,
  itemTitle,
  taskStreaming,
  activeItemId,
  latestItemId,
}: BrowseLoadingState): boolean {
  return !!itemStreaming || (
    itemEmpty &&
    isInFlightBrowsePlaceholder(itemTitle) &&
    taskStreaming &&
    !!activeItemId &&
    activeItemId === latestItemId
  )
}
