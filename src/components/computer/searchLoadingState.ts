export interface SearchLoadingState {
  itemStreaming?: boolean
  itemEmpty: boolean
  taskStreaming: boolean
  activeItemId?: string
  latestItemId?: string
}

/**
 * A completed empty payload can arrive before the task stream has reconciled
 * the persisted result. Only extend loading for the newest activity: older
 * empty searches must remain honest empty states when users revisit them.
 */
export function isSearchResultPending({
  itemStreaming,
  itemEmpty,
  taskStreaming,
  activeItemId,
  latestItemId,
}: SearchLoadingState): boolean {
  return !!itemStreaming ||
    (itemEmpty && taskStreaming && !!activeItemId && activeItemId === latestItemId)
}
