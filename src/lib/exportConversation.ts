import type { Conversation } from '@/types'

export function exportAsMarkdown(conversation: Conversation): string {
  let md = `# ${conversation.title}\n\n`
  md += `_Exported on ${new Date().toLocaleString()}_\n\n---\n\n`

  for (const msg of conversation.messages) {
    const role = msg.role === 'user' ? 'You' : 'Agent'
    md += `## ${role}\n\n${msg.content}\n\n---\n\n`
  }

  return md
}

export function exportAsJSON(conversation: Conversation): string {
  return JSON.stringify(conversation, null, 2)
}

export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
