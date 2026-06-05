export interface AgentEmail {
  to: string | string[]
  subject: string
  text: string
  html?: string
  idempotencyKey?: string
}

export interface EmailDeliveryResult {
  sent: boolean
  skipped: boolean
  providerId?: string
}

const RESEND_EMAIL_URL = 'https://api.resend.com/emails'
const DEFAULT_FROM = 'Agent 1.0 <onboarding@resend.dev>'

function normalizeEmailAddress(value: string | undefined, fallback = ''): string {
  return value?.trim() || fallback
}

export function getAdminEmail(): string {
  return normalizeEmailAddress(process.env.AGENT_ADMIN_EMAIL, 'aidan.marr1@gmail.com')
}

export function getAgentMailFrom(): string {
  return normalizeEmailAddress(process.env.AGENT_MAIL_FROM, DEFAULT_FROM)
}

function redactProviderError(value: string): string {
  const apiKey = process.env.RESEND_API_KEY
  return apiKey ? value.split(apiKey).join('[redacted-email-key]') : value
}

export async function sendAgentEmail(input: AgentEmail): Promise<EmailDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY is not configured; skipped "${input.subject}"`)
    return { sent: false, skipped: true }
  }

  const response = await fetch(RESEND_EMAIL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: getAgentMailFrom(),
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    }),
  })

  const body = await response.text()
  if (!response.ok) {
    throw new Error(`Email delivery failed (${response.status}): ${redactProviderError(body).slice(0, 800)}`)
  }

  let parsed: { id?: unknown } = {}
  try {
    parsed = JSON.parse(body) as { id?: unknown }
  } catch {
    // Provider returned a non-JSON success response.
  }

  return {
    sent: true,
    skipped: false,
    providerId: typeof parsed.id === 'string' ? parsed.id : undefined,
  }
}
