import type sharpFactory from 'sharp'

const PROFILE_AVATAR_SIZE = 256
const PROFILE_AVATAR_MAX_BYTES = 400 * 1024

export const PROFILE_AVATAR_MIME_TYPE = 'image/webp'

function baseName(fileName: string): string {
  const name = fileName
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return name || 'profile-avatar'
}

export function profileAvatarFileName(fileName: string): string {
  return `${baseName(fileName)}.webp`
}

export async function optimizeProfileImage(input: {
  body: Buffer
  fileName: string
}): Promise<{
  body: Buffer
  fileName: string
  mimeType: typeof PROFILE_AVATAR_MIME_TYPE
}> {
  let sharp: typeof sharpFactory
  try {
    const sharpModule = await import('sharp') as unknown as { default?: typeof sharpFactory } & typeof sharpFactory
    sharp = sharpModule.default ?? sharpModule
  } catch {
    throw new Error('Profile image optimizer is unavailable.')
  }

  const transformer = sharp(input.body, {
    animated: false,
    limitInputPixels: 36_000_000,
  })
    .rotate()
    .resize(PROFILE_AVATAR_SIZE, PROFILE_AVATAR_SIZE, {
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false,
    })

  let body = await transformer
    .clone()
    .webp({ quality: 82, effort: 4 })
    .toBuffer()

  if (body.byteLength > PROFILE_AVATAR_MAX_BYTES) {
    body = await transformer
      .clone()
      .webp({ quality: 72, effort: 4 })
      .toBuffer()
  }

  if (body.byteLength > PROFILE_AVATAR_MAX_BYTES) {
    throw new Error('Profile image could not be reduced enough.')
  }

  return {
    body,
    fileName: profileAvatarFileName(input.fileName),
    mimeType: PROFILE_AVATAR_MIME_TYPE,
  }
}
