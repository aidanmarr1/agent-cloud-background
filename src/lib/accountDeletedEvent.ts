export const ACCOUNT_DELETED_EVENT = 'agent:account-deleted'

export function dispatchAccountDeletedEvent() {
  if (typeof window === 'undefined') return

  try {
    window.dispatchEvent(new Event(ACCOUNT_DELETED_EVENT))
    return
  } catch {
    // Older/embedded browser contexts can lack the Event constructor.
  }

  if (typeof document !== 'undefined' && typeof document.createEvent === 'function') {
    const event = document.createEvent('Event')
    event.initEvent(ACCOUNT_DELETED_EVENT, false, false)
    window.dispatchEvent(event)
  }
}
