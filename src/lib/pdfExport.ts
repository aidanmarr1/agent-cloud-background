import { constants } from 'fs'
import { mkdir, open, stat, unlink } from 'fs/promises'
import { dirname, extname, join } from 'path'
import type { FileResult } from '@/types'
import { getOrCreateSandboxDir, isInsideSandbox, resolveAndVerify } from './sandbox'

type PdfExportResult = FileResult & { error?: string }

function normalizeWorkspacePath(path: string): string {
  return path.replace(/^\.?\/+/, '').replace(/\/+/g, '/') || 'deliverables/output.pdf'
}

function defaultPdfPath(sourcePath: string): string {
  const normalized = normalizeWorkspacePath(sourcePath)
  const ext = extname(normalized)
  if (!ext) return `${normalized}.pdf`
  return `${normalized.slice(0, -ext.length)}.pdf`
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inlineMarkdown(input: string): string {
  return escapeHtml(input)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function markdownToHtml(markdown: string): string {
  const blocks: string[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  let listItems: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }

  const flushList = () => {
    if (listItems.length === 0) return
    blocks.push(`<ul>${listItems.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`)
    listItems = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      listItems.push((bullet?.[1] || numbered?.[1] || '').trim())
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return blocks.join('\n')
}

function wrapHtml(content: string, title?: string): string {
  const safeTitle = escapeHtml(title || 'Document')
  const body = /<html[\s>]/i.test(content)
    ? content
    : `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body>${content}</body></html>`

  const styles = `
    <style>
      @page { margin: 0.75in; }
      body {
        color: #191919;
        background: #f5f5f5;
        font-family: "DM Sans", Arial, sans-serif;
        font-size: 11.5pt;
        line-height: 1.62;
      }
      main, body > article { max-width: 7.2in; margin: 0 auto; }
      h1, h2, h3, h4 {
        color: #191919;
        font-family: "Libre Baskerville", Georgia, serif;
        font-weight: 400;
        line-height: 1.18;
        margin: 1.35em 0 0.55em;
      }
      h1 { font-size: 26pt; margin-top: 0; }
      h2 { font-size: 18pt; }
      h3 { font-size: 14pt; }
      p { margin: 0 0 0.95em; }
      ul, ol { margin: 0 0 1em 1.4em; padding: 0; }
      li { margin: 0.25em 0; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
      }
      table { width: 100%; border-collapse: collapse; margin: 1em 0; }
      th, td { border: 1px solid #e3e3e2; padding: 0.45em 0.55em; text-align: left; }
    </style>
  `

  if (/<\/head>/i.test(body)) {
    return body.replace(/<\/head>/i, `${styles}</head>`)
  }
  return body.replace(/<body[^>]*>/i, match => `${match}${styles}`)
}

async function ensureSafeParent(sandboxDir: string, resolved: string): Promise<boolean> {
  let ancestor = dirname(resolved)
  while (true) {
    try {
      await stat(/* turbopackIgnore: true */ ancestor)
      break
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  return resolveAndVerify(sandboxDir, ancestor)
}

export async function exportPdfFromSandbox(
  conversationId: string,
  sourcePath: string,
  outputPath?: string,
  title?: string,
): Promise<PdfExportResult> {
  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const normalizedSource = normalizeWorkspacePath(sourcePath)
  const normalizedOutput = normalizeWorkspacePath(outputPath || defaultPdfPath(normalizedSource))
  const sourceResolved = join(/*turbopackIgnore: true*/ sandboxDir, normalizedSource)
  const outputResolved = join(/*turbopackIgnore: true*/ sandboxDir, normalizedOutput)

  if (!isInsideSandbox(sandboxDir, sourceResolved) || !isInsideSandbox(sandboxDir, outputResolved)) {
    return {
      action: 'exported',
      path: normalizedOutput,
      content: 'Error: path traversal not allowed',
      error: 'path traversal not allowed',
    }
  }

  if (!await resolveAndVerify(sandboxDir, sourceResolved)) {
    return {
      action: 'exported',
      path: normalizedOutput,
      content: 'Error: source path traversal not allowed',
      error: 'source path traversal not allowed',
    }
  }

  let source: string
  try {
    const sourceFile = await open(/* turbopackIgnore: true */ sourceResolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      source = await sourceFile.readFile('utf-8')
    } finally {
      await sourceFile.close()
    }
  } catch {
    return {
      action: 'exported',
      path: normalizedOutput,
      content: 'Error: source file not found',
      error: 'source file not found',
    }
  }

  if (!await ensureSafeParent(sandboxDir, outputResolved)) {
    return {
      action: 'exported',
      path: normalizedOutput,
      content: 'Error: output path traversal not allowed',
      error: 'output path traversal not allowed',
    }
  }

  const sourceExt = extname(normalizedSource).toLowerCase()
  const htmlBody = sourceExt === '.html' || sourceExt === '.htm'
    ? source
    : `<main>${markdownToHtml(source)}</main>`
  const html = wrapHtml(htmlBody, title || normalizedSource.split('/').pop())
  let browser: import('playwright').Browser | null = null
  let context: import('playwright').BrowserContext | null = null

  try {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ javaScriptEnabled: false })
    const page = await context.newPage()
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url()
      if (/^(about:|data:|blob:)/i.test(requestUrl)) {
        await route.continue()
        return
      }
      await route.abort('blockedbyclient')
    })
    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 })
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
    })

    await mkdir(/* turbopackIgnore: true */ dirname(outputResolved), { recursive: true })
    let fd: Awaited<ReturnType<typeof open>>
    try {
      fd = await open(
        /* turbopackIgnore: true */ outputResolved,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o644,
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'EMLINK') {
        return {
          action: 'exported',
          path: normalizedOutput,
          content: 'Error: path traversal not allowed',
          error: 'path traversal not allowed',
        }
      }
      throw err
    }

    try {
      await fd.writeFile(pdfBuffer)
    } finally {
      await fd.close()
    }

    if (!await resolveAndVerify(sandboxDir, outputResolved)) {
      try { await unlink(/* turbopackIgnore: true */ outputResolved) } catch { /* best effort */ }
      return {
        action: 'exported',
        path: normalizedOutput,
        content: 'Error: output path traversal not allowed',
        error: 'output path traversal not allowed',
      }
    }

    const fileStat = await stat(/* turbopackIgnore: true */ outputResolved)
    return { action: 'exported', path: normalizedOutput, size: fileStat.size }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      action: 'exported',
      path: normalizedOutput,
      content: `Error: PDF export failed: ${message}`,
      error: `PDF export failed: ${message}`,
    }
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}
