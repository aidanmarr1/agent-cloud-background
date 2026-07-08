import type { FileAttachment } from '@/types'

interface UploadResponseAttachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  persisted: true
  content?: string
  contentEncoding?: 'text'
}

interface UploadResult {
  attachments: FileAttachment[]
  errors: string[]
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

async function attachmentToFile(attachment: FileAttachment): Promise<File | null> {
  if (!attachment.content) return null

  if (attachment.content.startsWith('data:')) {
    const blob = await dataUrlToBlob(attachment.content)
    return new File([blob], attachment.name, { type: blob.type || attachment.type })
  }

  const blob = new Blob([attachment.content], { type: attachment.type || 'text/plain' })
  return new File([blob], attachment.name, { type: attachment.type || 'text/plain' })
}

export async function uploadAttachmentsToServer(
  attachments: FileAttachment[],
  conversationId?: string,
): Promise<UploadResult> {
  const uploadable: Array<{ originalIndex: number; file: File }> = []

  for (let index = 0; index < attachments.length; index += 1) {
    const file = await attachmentToFile(attachments[index])
    if (file) uploadable.push({ originalIndex: index, file })
  }

  if (uploadable.length === 0) {
    return { attachments, errors: [] }
  }

  const form = new FormData()
  if (conversationId) form.set('conversationId', conversationId)
  for (const item of uploadable) {
    form.append('files', item.file, item.file.name)
  }

  const response = await fetch('/api/attachments', {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    const message = typeof body?.error === 'string'
      ? body.error
      : 'Could not store attachments for reuse.'
    return { attachments, errors: [message] }
  }

  const body = await response.json().catch(() => null) as { attachments?: UploadResponseAttachment[] } | null
  const uploaded = body?.attachments || []
  const next = [...attachments]

  uploadable.forEach((item, uploadIndex) => {
    const stored = uploaded[uploadIndex]
    if (!stored) return
    const current = next[item.originalIndex]
    const extractedContent = typeof stored.content === 'string' && stored.content.trim()
      ? stored.content
      : undefined
    next[item.originalIndex] = {
      ...current,
      id: stored.id,
      name: stored.name || current.name,
      type: stored.type || current.type,
      size: Number.isFinite(stored.size) ? stored.size : current.size,
      url: stored.url,
      persisted: true,
      content: extractedContent,
      contentEncoding: extractedContent ? 'text' : undefined,
    }
  })

  return { attachments: next, errors: [] }
}

export async function bindAttachmentsToTask(
  attachments: FileAttachment[] | undefined,
  conversationId: string,
  messageId?: string,
): Promise<void> {
  const attachmentIds = (attachments || [])
    .map((attachment) => attachment.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  if (attachmentIds.length === 0) return

  await fetch('/api/attachments/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachmentIds, conversationId, messageId }),
  })
    .then(async (response) => {
      if (response.ok) return
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof body?.error === 'string' ? body.error : 'Could not bind attachments to the task.')
    })
}
