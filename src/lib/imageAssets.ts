import type sharpFactory from 'sharp'

export type ImageSearchType = 'photo' | 'any'

const NON_PHOTO_TITLE = /\b(?:cartoons?|illustrations?|vectors?|clip\s*art|icons?|drawings?|coloring\s+(?:pages?|books?)|colouring\s+(?:pages?|books?)|ai[-\s]?generated)\b/i

export function imageSearchType(value: unknown): ImageSearchType {
  return value === 'any' ? 'any' : 'photo'
}

export function imageSearchQuery(query: string, type: ImageSearchType): string {
  return type === 'photo'
    ? `${query} photograph -cartoon -illustration -vector -clipart -drawing -"AI generated"`
    : query
}

export function isImageSearchCandidate(title: string, type: ImageSearchType): boolean {
  return type !== 'photo' || !NON_PHOTO_TITLE.test(title)
}

/** Validate the downloaded bytes, not a URL suffix or an HTTP 200 alone. */
export async function validateDownloadedImage(body: Buffer, minimumDimension = 128): Promise<{ extension: string; width: number; height: number }> {
  const sharpModule = await import('sharp') as unknown as { default?: typeof sharpFactory } & typeof sharpFactory
  const sharp = sharpModule.default ?? sharpModule
  const input = sharp(body, { limitInputPixels: 40_000_000, failOn: 'error', animated: false })
  const metadata = await input.metadata()
  const extensions: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif' }
  const extension = extensions[metadata.format || '']
  if (!extension) throw new Error('Downloaded content is not a supported raster image.')
  if (!metadata.width || !metadata.height || metadata.width < minimumDimension || metadata.height < minimumDimension) {
    throw new Error('Downloaded image is too small for a usable visual asset.')
  }
  // A header alone is not proof that the complete image can be decoded.
  await input.resize(32, 32, { fit: 'inside' }).raw().toBuffer()
  return { extension, width: metadata.width, height: metadata.height }
}

export interface DownloadedImageAsset {
  path: string
  imageUrl: string
  title: string
  thumbnailUrl: string
  sourceUrl: string
  width: number
  height: number
}

/** A bad optional image must not discard the good ones or terminate the task. */
export async function persistImageSearchDownloads<T extends Record<string, unknown>>(
  result: T,
  persist: (path: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<T & { downloaded: string[] }> {
  const paths = Array.isArray(result.downloaded)
    ? result.downloaded.filter((path): path is string => typeof path === 'string' && !!path)
    : []
  const saved: string[] = []
  const unsaved: string[] = []
  // Keep writes bounded. Each file is independently committed, so a later
  // failure never removes previously persisted assets.
  for (const path of paths) {
    signal?.throwIfAborted()
    try {
      if (!await persist(path)) throw new Error('Image was not saved.')
      saved.push(path)
    } catch {
      signal?.throwIfAborted()
      unsaved.push(path)
    }
  }
  if (unsaved.length === 0) return { ...result, downloaded: saved }
  const warning = [
    typeof result.warning === 'string' ? result.warning : '',
    `${saved.length} of ${paths.length} downloaded images were saved. ${unsaved.length} could not be saved durably; use the saved assets or retry those sources.`,
  ].filter(Boolean).join(' ')
  return {
    ...result,
    downloaded: saved,
    assets: Array.isArray(result.assets)
      ? result.assets.filter(asset => !!asset && typeof asset === 'object' && saved.includes(String((asset as { path?: unknown }).path || '')))
      : [],
    unsaved,
    warning,
    message: warning,
    recoverable: true,
  }
}
