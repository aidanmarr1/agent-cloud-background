/** Standalone hydration signal — no store imports to avoid circular chunks */
let _hydrated = false
const _listeners: Array<() => void> = []

export function signalStoreHydrated() {
  _hydrated = true
  _listeners.forEach((fn) => fn())
  _listeners.length = 0
}

export function resetStoreHydration() {
  _hydrated = false
}

export function isStoreHydrated() {
  return _hydrated
}

export function onStoreHydrated(fn: () => void): () => void {
  if (_hydrated) {
    fn()
    return () => {}
  }
  _listeners.push(fn)
  return () => {
    const i = _listeners.indexOf(fn)
    if (i >= 0) _listeners.splice(i, 1)
  }
}
