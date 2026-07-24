export type BrowserSessionFenceRelease = () => void
export type BrowserSessionFenceAcquirer = (conversationId: string) => Promise<BrowserSessionFenceRelease>

const registryKey = '__browserSessionFenceAcquirer' as const

export function registerBrowserSessionFenceAcquirer(acquirer: BrowserSessionFenceAcquirer): void {
  ;(globalThis as unknown as Record<string, BrowserSessionFenceAcquirer>)[registryKey] = acquirer
}

export async function acquireRegisteredBrowserSessionFence(
  conversationId: string,
): Promise<BrowserSessionFenceRelease> {
  const acquirer = (globalThis as unknown as Record<string, BrowserSessionFenceAcquirer | undefined>)[registryKey]
  return acquirer ? acquirer(conversationId) : () => undefined
}
