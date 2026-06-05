import { createHash, randomBytes } from 'crypto'
import { hashPassword } from '@/lib/auth/password'
import {
  approveUserAccess,
  AuthUserError,
  createUserWithPasswordHash,
  findUserByEmail,
  findUserById,
  normalizeEmail,
} from '@/lib/auth/users'
import { tursoExecute } from '@/lib/db/turso'
import { getAdminEmail, sendAgentEmail } from '@/lib/email'

type SignupRequestStatus = 'pending' | 'accepted' | 'declined'
type SignupDecision = 'accept'

interface SignupRequestRow {
  id?: unknown
  user_id?: unknown
  name?: unknown
  email?: unknown
  password_hash?: unknown
  status?: unknown
  review_token_hash?: unknown
  created_at?: unknown
  updated_at?: unknown
  decided_at?: unknown
}

export interface SignupRequestRecord {
  id: string
  userId: string | null
  name: string | null
  email: string
  passwordHash: string
  status: SignupRequestStatus
  reviewTokenHash: string
  createdAt: string
  updatedAt: string
  decidedAt: string | null
}

export interface SignupRequestResult {
  request: SignupRequestRecord
  reviewToken: string
  adminEmailSent: boolean
}

export interface SignupReviewResult {
  request: SignupRequestRecord
  decision: SignupDecision
  createdUser: boolean
}

let signupRequestSchemaPromise: Promise<void> | null = null

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function createReviewToken(): string {
  return randomBytes(32).toString('base64url')
}

function textFromUnknown(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function rowToSignupRequest(row: SignupRequestRow | undefined): SignupRequestRecord | null {
  if (!row) return null
  const id = textFromUnknown(row.id)
  const userId = textFromUnknown(row.user_id)
  const email = textFromUnknown(row.email)
  const passwordHash = textFromUnknown(row.password_hash)
  const status = textFromUnknown(row.status) as SignupRequestStatus | null
  const reviewTokenHash = textFromUnknown(row.review_token_hash)
  const createdAt = textFromUnknown(row.created_at)
  const updatedAt = textFromUnknown(row.updated_at)

  if (
    !id ||
    !email ||
    !passwordHash ||
    !reviewTokenHash ||
    !createdAt ||
    !updatedAt ||
    !status ||
    !['pending', 'accepted', 'declined'].includes(status)
  ) {
    return null
  }

  return {
    id,
    userId,
    name: textFromUnknown(row.name),
    email,
    passwordHash,
    status,
    reviewTokenHash,
    createdAt,
    updatedAt,
    decidedAt: textFromUnknown(row.decided_at),
  }
}

async function ensureSignupRequestSchema(): Promise<void> {
  if (!signupRequestSchemaPromise) {
    signupRequestSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists signup_requests (
          id text primary key,
          user_id text,
          name text,
          email text not null unique,
          password_hash text not null,
          status text not null,
          review_token_hash text not null,
          created_at text not null,
          updated_at text not null,
          decided_at text
        )
      `)
      await tursoExecute('alter table signup_requests add column user_id text')
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error || '')
          if (!/duplicate column|already exists/i.test(message)) throw error
        })
      await tursoExecute('create index if not exists signup_requests_status_created_idx on signup_requests(status, created_at desc)')
      await tursoExecute('create index if not exists signup_requests_email_idx on signup_requests(email)')
      await tursoExecute('create index if not exists signup_requests_user_idx on signup_requests(user_id)')
    })().catch((error) => {
      signupRequestSchemaPromise = null
      throw error
    })
  }

  return signupRequestSchemaPromise
}

async function findSignupRequestByEmail(email: string): Promise<SignupRequestRecord | null> {
  await ensureSignupRequestSchema()
  const result = await tursoExecute(
    'select * from signup_requests where email = ? limit 1',
    [email],
  )
  return rowToSignupRequest(result.rows[0] as SignupRequestRow | undefined)
}

async function findSignupRequestById(id: string): Promise<SignupRequestRecord | null> {
  await ensureSignupRequestSchema()
  const result = await tursoExecute(
    'select * from signup_requests where id = ? limit 1',
    [id],
  )
  return rowToSignupRequest(result.rows[0] as SignupRequestRow | undefined)
}

async function findSignupRequestByUserId(userId: string): Promise<SignupRequestRecord | null> {
  await ensureSignupRequestSchema()
  const result = await tursoExecute(
    'select * from signup_requests where user_id = ? limit 1',
    [userId],
  )
  return rowToSignupRequest(result.rows[0] as SignupRequestRow | undefined)
}

function getAppBaseUrl(request: Request): string {
  const configured =
    process.env.AGENT_APP_URL?.trim() ||
    process.env.AUTH_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')

  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // Fall back to request URL.
    }
  }

  return new URL(request.url).origin
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function reviewUrl(baseUrl: string, requestId: string, decision: SignupDecision, token: string): string {
  const url = new URL('/api/auth/signup/review', baseUrl)
  url.searchParams.set('id', requestId)
  url.searchParams.set('decision', decision)
  url.searchParams.set('token', token)
  return url.toString()
}

async function sendAdminRequestEmail(
  request: SignupRequestRecord,
  reviewToken: string,
  baseUrl: string,
): Promise<boolean> {
  const acceptUrl = reviewUrl(baseUrl, request.id, 'accept', reviewToken)
  const name = request.name || 'No name provided'
  const subject = `New Agent 1.0 signup request: ${request.email}`

  const result = await sendAgentEmail({
    to: getAdminEmail(),
    subject,
    idempotencyKey: `signup-request-${request.id}-${request.updatedAt}`,
    text: [
      'A new Agent 1.0 signup request is waiting for review.',
      '',
      `Name: ${name}`,
      `Email: ${request.email}`,
      `Request ID: ${request.id}`,
      '',
      `Accept: ${acceptUrl}`,
      '',
      'There is no decline action. Leave this request pending if you do not want to approve it.',
    ].join('\n'),
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#111">
        <h2 style="margin:0 0 12px">New Agent 1.0 signup request</h2>
        <p style="margin:0 0 16px">A new user is waiting for access.</p>
        <p style="margin:0 0 6px"><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p style="margin:0 0 18px"><strong>Email:</strong> ${escapeHtml(request.email)}</p>
        <p style="margin:0 0 18px">
          <a href="${escapeHtml(acceptUrl)}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Accept request</a>
        </p>
        <p style="margin:0 0 18px;color:#666;font-size:13px">There is no decline action. If this person should not get access, leave the request pending.</p>
        <p style="margin:0;color:#666;font-size:13px">Request ID: ${escapeHtml(request.id)}</p>
      </div>
    `,
  })

  return result.sent
}

export async function createSignupRequest(input: {
  request: Request
  name?: string
  email: string
  password: string
}): Promise<SignupRequestResult> {
  const email = normalizeEmail(input.email)
  if (!email || input.password.length < 8) {
    throw new AuthUserError('INVALID_INPUT')
  }

  const existingUser = await findUserByEmail(email)
  if (existingUser) {
    throw new AuthUserError('EMAIL_IN_USE')
  }

  await ensureSignupRequestSchema()

  const now = new Date().toISOString()
  const reviewToken = createReviewToken()
  const reviewTokenHash = hashSecret(reviewToken)
  const name = input.name?.trim().slice(0, 80) || null
  const passwordHash = hashPassword(input.password)
  const existing = await findSignupRequestByEmail(email)
  const id = existing?.id || randomBytes(16).toString('hex')

  if (existing) {
    await tursoExecute(
      `
        update signup_requests
        set user_id = coalesce(user_id, ?), name = ?, password_hash = ?, status = 'pending', review_token_hash = ?, updated_at = ?, decided_at = null
        where id = ?
      `,
      [null, name, passwordHash, reviewTokenHash, now, existing.id],
    )
  } else {
    await tursoExecute(
      `
        insert into signup_requests (
          id, user_id, name, email, password_hash, status, review_token_hash, created_at, updated_at, decided_at
        )
        values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, null)
      `,
      [id, null, name, email, passwordHash, reviewTokenHash, now, now],
    )
  }

  const request = await findSignupRequestById(id)
  if (!request) {
    throw new Error('Signup request could not be saved.')
  }

  let adminEmailSent = false
  try {
    adminEmailSent = await sendAdminRequestEmail(request, reviewToken, getAppBaseUrl(input.request))
  } catch (error) {
    console.error('[signup] Could not email signup request:', error)
  }

  return { request, reviewToken, adminEmailSent }
}

export async function findSignupRequestForUser(input: {
  userId: string
  email: string
}): Promise<SignupRequestRecord | null> {
  const byUserId = await findSignupRequestByUserId(input.userId)
  if (byUserId) return byUserId
  return findSignupRequestByEmail(normalizeEmail(input.email))
}

export async function createApprovalRequestForUser(input: {
  request: Request
  userId: string
}): Promise<SignupRequestResult> {
  const user = await findUserById(input.userId)
  if (!user) {
    throw new AuthUserError('INVALID_CREDENTIALS')
  }
  if (user.accessStatus === 'approved') {
    throw new AuthUserError('INVALID_INPUT')
  }

  await ensureSignupRequestSchema()

  const now = new Date().toISOString()
  const reviewToken = createReviewToken()
  const reviewTokenHash = hashSecret(reviewToken)
  const existing = await findSignupRequestForUser({ userId: user.id, email: user.email })
  const id = existing?.id || randomBytes(16).toString('hex')

  if (existing) {
    await tursoExecute(
      `
        update signup_requests
        set user_id = ?, name = ?, email = ?, password_hash = ?, status = 'pending', review_token_hash = ?, updated_at = ?, decided_at = null
        where id = ?
      `,
      [user.id, user.name, user.email, user.passwordHash, reviewTokenHash, now, existing.id],
    )
  } else {
    await tursoExecute(
      `
        insert into signup_requests (
          id, user_id, name, email, password_hash, status, review_token_hash, created_at, updated_at, decided_at
        )
        values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, null)
      `,
      [id, user.id, user.name, user.email, user.passwordHash, reviewTokenHash, now, now],
    )
  }

  const signupRequest = await findSignupRequestById(id)
  if (!signupRequest) {
    throw new Error('Signup request could not be saved.')
  }

  let adminEmailSent = false
  try {
    adminEmailSent = await sendAdminRequestEmail(signupRequest, reviewToken, getAppBaseUrl(input.request))
  } catch (error) {
    console.error('[signup] Could not email signup request:', error)
  }

  return { request: signupRequest, reviewToken, adminEmailSent }
}

export async function reviewSignupRequest(input: {
  request: Request
  id: string
  token: string
  decision: SignupDecision
}): Promise<SignupReviewResult> {
  await ensureSignupRequestSchema()
  const request = await findSignupRequestById(input.id)
  if (!request) {
    throw new AuthUserError('INVALID_INPUT')
  }

  const tokenHash = hashSecret(input.token)
  if (request.reviewTokenHash !== tokenHash) {
    throw new AuthUserError('INVALID_INPUT')
  }

  if (request.status !== 'pending') {
    return {
      request,
      decision: input.decision,
      createdUser: false,
    }
  }

  let createdUser = false
  const acceptedAt = Date.now()
  const acceptedAtIso = new Date(acceptedAt).toISOString()
  const creditGrantId = `credit:access-approval:${request.id}`
  if (input.decision === 'accept') {
    try {
      const existingUser = request.userId
        ? await findUserById(request.userId)
        : await findUserByEmail(request.email)

      if (existingUser) {
        await approveUserAccess(existingUser.id, {
          creditGrantId,
          acceptedAt,
        })
      } else {
        const user = await createUserWithPasswordHash({
          name: request.name,
          email: request.email,
          passwordHash: request.passwordHash,
          accessStatus: 'pending',
        })
        await approveUserAccess(user.id, {
          creditGrantId,
          acceptedAt,
        })
        createdUser = true
      }
    } catch (error) {
      if (!(error instanceof AuthUserError && error.code === 'EMAIL_IN_USE')) {
        throw error
      }
    }
  }

  const status = input.decision === 'accept' ? 'accepted' : 'declined'
  await tursoExecute(
    `
      update signup_requests
      set status = ?, updated_at = ?, decided_at = ?
      where id = ? and status = 'pending'
    `,
    [status, acceptedAtIso, acceptedAtIso, request.id],
  )

  const updated = await findSignupRequestById(request.id)
  if (!updated) {
    throw new Error('Signup request could not be updated.')
  }

  return {
    request: updated,
    decision: input.decision,
    createdUser,
  }
}
