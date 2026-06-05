import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto'

const HASH_ALGORITHM = 'pbkdf2_sha256'
const ITERATIONS = 210_000
const KEY_LENGTH = 32
const DIGEST = 'sha256'

function encodeBase64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST)
  return `${HASH_ALGORITHM}$${ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(hash)}`
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = storedHash.split('$')

  if (algorithm !== HASH_ALGORITHM || !iterationsRaw || !saltRaw || !hashRaw) {
    return false
  }

  const iterations = Number.parseInt(iterationsRaw, 10)
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false
  }

  try {
    const salt = decodeBase64Url(saltRaw)
    const expectedHash = decodeBase64Url(hashRaw)
    const actualHash = pbkdf2Sync(password, salt, iterations, expectedHash.length, DIGEST)

    if (actualHash.length !== expectedHash.length) {
      return false
    }

    return timingSafeEqual(actualHash, expectedHash)
  } catch {
    return false
  }
}
