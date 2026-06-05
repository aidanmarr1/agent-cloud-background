import { randomUUID } from 'crypto'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { getAttachmentForUser } from '@/lib/attachments'
import { tursoExecute } from '@/lib/db/turso'
import { ACCOUNT_MONTHLY_CREDITS, ensureAccountCredits, grantMonthlyAccountCredits, initializeAccountCredits } from '@/lib/serverCredits'

export type UserAccessStatus = 'pending' | 'approved'

export type PublicAuthUser = {
  id: string
  name: string | null
  email: string
  image: string | null
  imageAttachmentId: string | null
  accessStatus: UserAccessStatus
}

type UserRow = {
  id?: unknown
  name?: unknown
  email?: unknown
  password_hash?: unknown
  profile_image_attachment_id?: unknown
  access_status?: unknown
}

export class AuthUserError extends Error {
  constructor(readonly code: 'EMAIL_IN_USE' | 'INVALID_CREDENTIALS' | 'INVALID_INPUT') {
    super(code)
  }
}

let authSchemaPromise: Promise<void> | null = null

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function ensureAuthSchema(): Promise<void> {
  if (!authSchemaPromise) {
    authSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists users (
          id text primary key,
          name text,
          email text not null unique,
          password_hash text not null,
          created_at text not null,
          updated_at text not null
        )
      `)
      await tursoExecute('create index if not exists users_email_idx on users(email)')
      await tursoExecute('alter table users add column profile_image_attachment_id text')
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error || '')
          if (!/duplicate column|already exists/i.test(message)) throw error
        })
      await tursoExecute("alter table users add column access_status text not null default 'approved'")
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error || '')
          if (!/duplicate column|already exists/i.test(message)) throw error
        })
      await tursoExecute('create index if not exists users_profile_image_attachment_idx on users(profile_image_attachment_id)')
      await tursoExecute('create index if not exists users_access_status_idx on users(access_status)')
    })().catch((error) => {
      authSchemaPromise = null
      throw error
    })
  }

  return authSchemaPromise
}

function toPublicUser(row: UserRow): PublicAuthUser | null {
  if (typeof row.id !== 'string' || typeof row.email !== 'string') {
    return null
  }
  const imageAttachmentId = typeof row.profile_image_attachment_id === 'string' && row.profile_image_attachment_id.trim()
    ? row.profile_image_attachment_id.trim()
    : null

  return {
    id: row.id,
    email: row.email,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : null,
    imageAttachmentId,
    image: imageAttachmentId ? `/api/attachments/${imageAttachmentId}` : null,
    accessStatus: row.access_status === 'pending' ? 'pending' : 'approved',
  }
}

export async function findUserByEmail(email: string): Promise<(PublicAuthUser & { passwordHash: string }) | null> {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return null

  await ensureAuthSchema()

  const result = await tursoExecute(
    'select id, name, email, password_hash, profile_image_attachment_id, access_status from users where email = ? limit 1',
    [normalizedEmail],
  )
  const row = result.rows[0] as UserRow | undefined
  if (!row || typeof row.password_hash !== 'string') {
    return null
  }

  const publicUser = toPublicUser(row)
  if (!publicUser) return null

  return {
    ...publicUser,
    passwordHash: row.password_hash,
  }
}

export async function findUserById(id: string): Promise<(PublicAuthUser & { passwordHash: string }) | null> {
  const userId = id.trim()
  if (!userId) return null

  await ensureAuthSchema()

  const result = await tursoExecute(
    'select id, name, email, password_hash, profile_image_attachment_id, access_status from users where id = ? limit 1',
    [userId],
  )
  const row = result.rows[0] as UserRow | undefined
  if (!row || typeof row.password_hash !== 'string') {
    return null
  }

  const publicUser = toPublicUser(row)
  if (!publicUser) return null

  return {
    ...publicUser,
    passwordHash: row.password_hash,
  }
}

export async function createUser(input: {
  name?: string
  email: string
  password: string
  accessStatus?: UserAccessStatus
}): Promise<PublicAuthUser> {
  return createUserWithPasswordHash({
    name: input.name,
    email: input.email,
    passwordHash: hashPassword(input.password),
    accessStatus: input.accessStatus,
  })
}

export async function createUserWithPasswordHash(input: {
  name?: string | null
  email: string
  passwordHash: string
  accessStatus?: UserAccessStatus
}): Promise<PublicAuthUser> {
  const email = normalizeEmail(input.email)
  const name = input.name?.trim() || null
  const accessStatus = input.accessStatus === 'pending' ? 'pending' : 'approved'

  if (!email || !input.passwordHash.startsWith('pbkdf2_sha256$')) {
    throw new AuthUserError('INVALID_INPUT')
  }

  await ensureAuthSchema()

  const existing = await findUserByEmail(email)
  if (existing) {
    throw new AuthUserError('EMAIL_IN_USE')
  }

  const now = new Date().toISOString()
  const user: PublicAuthUser = {
    id: randomUUID(),
    name,
    email,
    image: null,
    imageAttachmentId: null,
    accessStatus,
  }

  try {
    await tursoExecute(
      `
        insert into users (id, name, email, password_hash, access_status, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      [user.id, user.name, user.email, input.passwordHash, accessStatus, now, now],
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/unique|constraint/i.test(message)) {
      throw new AuthUserError('EMAIL_IN_USE')
    }
    throw error
  }

  if (accessStatus === 'pending') {
    await initializeAccountCredits(user.id, {
      monthlyAllowance: ACCOUNT_MONTHLY_CREDITS,
      monthlyBalance: 0,
    })
  } else {
    await ensureAccountCredits(user.id)
  }

  return user
}

export async function verifyUserCredentials(email: string, password: string): Promise<PublicAuthUser | null> {
  const user = await findUserByEmail(email)
  if (!user) return null

  const valid = verifyPassword(password, user.passwordHash)
  if (!valid) return null

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    imageAttachmentId: user.imageAttachmentId,
    accessStatus: user.accessStatus,
  }
}

export async function approveUserAccess(
  userId: string,
  options: { creditGrantId?: string; acceptedAt?: number } = {},
): Promise<PublicAuthUser> {
  const id = userId.trim()
  if (!id) throw new AuthUserError('INVALID_INPUT')

  await ensureAuthSchema()
  const acceptedAt = options.acceptedAt || Date.now()
  await tursoExecute(
    'update users set access_status = ?, updated_at = ? where id = ?',
    ['approved', new Date(acceptedAt).toISOString(), id],
  )
  await grantMonthlyAccountCredits(id, {
    monthlyAllowance: ACCOUNT_MONTHLY_CREDITS,
    monthlyBalance: ACCOUNT_MONTHLY_CREDITS,
    grantId: options.creditGrantId,
    reason: 'Agent Admin credit grant',
    timestamp: acceptedAt,
  })

  const user = await findUserById(id)
  if (!user) throw new AuthUserError('INVALID_CREDENTIALS')
  return user
}

export async function setUserProfileImageAttachment(input: {
  userId: string
  attachmentId: string | null
}): Promise<{ user: PublicAuthUser; previousAttachmentId: string | null }> {
  const userId = input.userId.trim()
  const attachmentId = input.attachmentId?.trim() || null
  if (!userId) throw new AuthUserError('INVALID_INPUT')

  const current = await findUserById(userId)
  if (!current) throw new AuthUserError('INVALID_CREDENTIALS')

  if (attachmentId) {
    const attachment = await getAttachmentForUser(userId, attachmentId)
    if (!attachment || attachment.kind !== 'image') {
      throw new AuthUserError('INVALID_INPUT')
    }
  }

  await tursoExecute(
    'update users set profile_image_attachment_id = ?, updated_at = ? where id = ?',
    [attachmentId, new Date().toISOString(), userId],
  )

  const updated = await findUserById(userId)
  if (!updated) throw new AuthUserError('INVALID_CREDENTIALS')

  return {
    user: updated,
    previousAttachmentId: current.imageAttachmentId,
  }
}

export async function changeUserPassword(input: {
  userId: string
  currentPassword: string
  newPassword: string
}): Promise<void> {
  const userId = input.userId.trim()
  if (!userId || input.currentPassword.length === 0 || input.newPassword.length < 8 || input.newPassword.length > 256) {
    throw new AuthUserError('INVALID_INPUT')
  }

  const user = await findUserById(userId)
  if (!user) {
    throw new AuthUserError('INVALID_CREDENTIALS')
  }

  const valid = verifyPassword(input.currentPassword, user.passwordHash)
  if (!valid) {
    throw new AuthUserError('INVALID_CREDENTIALS')
  }

  await tursoExecute(
    'update users set password_hash = ?, updated_at = ? where id = ?',
    [hashPassword(input.newPassword), new Date().toISOString(), userId],
  )
}
