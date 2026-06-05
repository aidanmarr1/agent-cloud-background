import { AuthUserError } from '@/lib/auth/users'
import { reviewSignupRequest } from '@/lib/auth/signupRequests'

export const runtime = 'nodejs'

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1a1a1a; color: #f4f4f4; font-family: "Segoe UI", Arial, sans-serif; }
      main { width: min(420px, calc(100vw - 40px)); border: 1px solid #343434; border-radius: 18px; background: #262625; padding: 28px; box-shadow: 0 20px 70px rgba(0, 0, 0, .28); }
      h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.15; }
      p { margin: 0; color: #aaa; line-height: 1.5; font-size: 14px; }
      a { color: #f4f4f4; }
    </style>
  </head>
  <body><main>${body}</main></body>
</html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const id = url.searchParams.get('id')?.trim() || ''
  const token = url.searchParams.get('token')?.trim() || ''
  const decision = url.searchParams.get('decision')?.trim() || ''

  if (!id || !token || decision !== 'accept') {
    return htmlPage(
      'Invalid review link',
      '<h1>Invalid review link</h1><p>This signup review link is missing required information or uses an unsupported action.</p>',
      400,
    )
  }

  try {
    const result = await reviewSignupRequest({
      request,
      id,
      token,
      decision: 'accept',
    })

    const email = escapeHtml(result.request.email)
    const title = 'Access approved'
    const accountNotice = result.createdUser
      ? 'The account has been created and the 1,000 credits have been granted.'
      : 'The account is approved and the 1,000 credits have been granted.'

    return htmlPage(
      title,
      `<h1>${title}</h1><p>${email} has been approved. ${accountNotice}</p>`,
    )
  } catch (error) {
    if (error instanceof AuthUserError) {
      return htmlPage(
        'Invalid review link',
        '<h1>Invalid review link</h1><p>This signup review link is invalid or has expired.</p>',
        403,
      )
    }

    return htmlPage(
      'Review failed',
      '<h1>Review failed</h1><p>The request could not be reviewed. Try again in a moment.</p>',
      500,
    )
  }
}
