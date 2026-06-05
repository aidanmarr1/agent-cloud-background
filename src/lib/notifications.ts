export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  const result = await Notification.requestPermission()
  return result === 'granted'
}

export function sendDesktopNotification(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  new Notification(title, {
    body,
    icon: '/logo.svg',
    silent: false,
  })
}

let originalTitle = ''
export function setBadgeCount(count: number) {
  if (!originalTitle) originalTitle = document.title
  document.title = count > 0 ? `(${count}) ${originalTitle}` : originalTitle
  if ('setAppBadge' in navigator) {
    if (count > 0) {
      (navigator as any).setAppBadge(count)
    } else {
      (navigator as any).clearAppBadge()
    }
  }
}

export function resetBadge() {
  setBadgeCount(0)
}
