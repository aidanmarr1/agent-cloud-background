import { constants } from 'fs'
import { open } from 'fs/promises'
import { join, relative, isAbsolute } from 'path'
import { resolveAndVerify } from '@/lib/sandbox'

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']

export function inferArtifactType(filePath: string): 'document' | 'code' | 'data' | 'image' {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (IMAGE_EXTENSIONS.includes(ext || '')) return 'image'
  if (['md', 'txt', 'rtf', 'pdf'].includes(ext || '')) return 'document'
  if (['csv', 'json', 'xml', 'yaml', 'yml'].includes(ext || '')) return 'data'
  return 'code'
}

export const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
}

export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

export async function tryEncodeImageBase64(sandboxDir: string, filePath: string): Promise<string | undefined> {
  try {
    const resolved = join(sandboxDir, filePath)
    const rel = relative(sandboxDir, resolved)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
    // Symlink-aware verification: a file inside the sandbox could be a symlink
    // pointing outside it, which the string check above doesn't catch.
    if (!await resolveAndVerify(sandboxDir, resolved)) return undefined
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const mime = MIME_MAP[ext]
    if (!mime) return undefined
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const s = await file.stat()
      if (s.size > MAX_INLINE_IMAGE_BYTES) return undefined
      const buf = await file.readFile()
      return `data:${mime};base64,${buf.toString('base64')}`
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}
