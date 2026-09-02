import { extname } from 'path'
import type { FileResult } from '@/types'
import { readSandboxFileBytes, writeSandboxFileBytes } from './sandbox'

type PdfExportResult = FileResult & {
  error?: string
  validated?: boolean
  validation?: string
  pageSize?: 'A4'
  renderValidation?: {
    textCharacters: number
    headingCount: number
    linkCount: number
    tableCount: number
    horizontalOverflow: boolean
    bodyBackground: string
    previewNonBlank: boolean
  }
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/^\.?\/+/, '').replace(/\/+/g, '/') || 'deliverables/output.pdf'
}

function isSafeWorkspacePath(path: string): boolean {
  return !!path && !path.includes('\0') && !path.split('/').some(part => part === '..')
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
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_match, label: string, url: string) => {
      const safeUrl = url.replace(/&amp;/g, '&')
      try {
        const parsed = new URL(safeUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return label
        return `<a href="${escapeHtml(parsed.toString())}">${label}</a>`
      } catch {
        return label
      }
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function markdownToHtml(markdown: string): string {
  const blocks: string[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  let listItems: string[] = []
  let listType: 'ul' | 'ol' | null = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }

  const flushList = () => {
    if (listItems.length === 0 || !listType) return
    blocks.push(`<${listType}>${listItems.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</${listType}>`)
    listItems = []
    listType = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
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

    if (/^```/.test(line)) {
      flushParagraph()
      flushList()
      const language = line.replace(/^```/, '').trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        code.push(lines[index])
        index += 1
      }
      blocks.push(`<pre${language ? ` data-language="${escapeHtml(language)}"` : ''}><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    if (/^(?:---+|___+|\*\*\*+)$/i.test(line)) {
      flushParagraph()
      flushList()
      blocks.push('<hr>')
      continue
    }

    const nextLine = lines[index + 1]?.trim() || ''
    if (line.includes('|') && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(nextLine)) {
      flushParagraph()
      flushList()
      const splitCells = (value: string) => value
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(cell => cell.trim())
      const headers = splitCells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitCells(lines[index].trim()))
        index += 1
      }
      index -= 1
      blocks.push([
        '<table><thead><tr>',
        headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join(''),
        '</tr></thead><tbody>',
        rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || '')}</td>`).join('')}</tr>`).join(''),
        '</tbody></table>',
      ].join(''))
      continue
    }

    const quote = /^>\s*(.+)$/.exec(line)
    if (quote) {
      flushParagraph()
      flushList()
      blocks.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`)
      continue
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const nextType = numbered ? 'ol' : 'ul'
      if (listType && listType !== nextType) flushList()
      listType = nextType
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

function wrapHtml(content: string, title?: string, preserveSourceDesign = false): string {
  const safeTitle = escapeHtml(title || 'Document')
  const body = /<html[\s>]/i.test(content)
    ? content
    : `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body><article class="document-shell">${content}</article></body></html>`

  const sourcePrintStyles = `
    <style>
      @page { size: A4; margin: 0.75in; }
      @media print {
        html, body { background: #fff !important; }
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        img, svg, canvas, table, pre, blockquote { break-inside: avoid; }
      }
    </style>
  `
  const documentStyles = `
    <style>
      @page { size: A4; margin: 0.72in 0.72in 0.78in; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body {
        color: #172033;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        font-size: 10.6pt;
        line-height: 1.58;
      }
      .document-shell { max-width: 7.15in; margin: 0 auto; }
      main { width: 100%; }
      h1, h2, h3, h4 {
        color: #10233f;
        font-family: Georgia, "Times New Roman", serif;
        line-height: 1.2;
        break-after: avoid;
      }
      h1 { font-size: 25pt; margin: 0 0 0.7em; padding-bottom: 0.34em; border-bottom: 2px solid #1f6b70; }
      h2 { font-size: 17pt; margin: 1.4em 0 0.55em; padding-bottom: 0.2em; border-bottom: 1px solid #d7e0e7; }
      h3 { font-size: 13.5pt; margin: 1.25em 0 0.45em; }
      h4 { font-size: 11.5pt; margin: 1.1em 0 0.4em; }
      p { margin: 0 0 0.95em; }
      ul, ol { margin: 0 0 1em 1.4em; padding: 0; }
      li { margin: 0.25em 0; }
      a { color: #17646a; text-decoration: underline; text-underline-offset: 0.12em; overflow-wrap: anywhere; }
      strong { color: #10233f; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
        color: #163c5b;
        background: #eef3f5;
        padding: 0.08em 0.28em;
        border-radius: 3px;
      }
      pre { background: #f4f7f8; border: 1px solid #d7e0e7; padding: 0.8em; overflow-wrap: anywhere; white-space: pre-wrap; }
      pre code { background: transparent; padding: 0; }
      blockquote { margin: 1em 0; padding: 0.2em 0 0.2em 0.85em; border-left: 3px solid #1f6b70; color: #42526a; }
      hr { border: 0; border-top: 1px solid #d7e0e7; margin: 1.5em 0; }
      table { width: 100%; border-collapse: collapse; margin: 1.15em 0; font-size: 9.4pt; }
      thead { display: table-header-group; }
      th { color: #fff; background: #173b5b; font-weight: 650; }
      th, td { border: 1px solid #cfd9e1; padding: 0.5em 0.58em; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
      tbody tr:nth-child(even) { background: #f5f8fa; }
      img { max-width: 100%; height: auto; }
      @media print {
        html, body { background: #fff !important; }
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        img, svg, canvas, table, pre, blockquote { break-inside: avoid; }
      }
    </style>
  `
  const styles = preserveSourceDesign ? sourcePrintStyles : documentStyles

  if (/<\/head>/i.test(body)) {
    return body.replace(/<\/head>/i, `${styles}</head>`)
  }
  return body.replace(/<body[^>]*>/i, match => `${match}${styles}`)
}

export async function exportPdfFromSandbox(
  conversationId: string,
  sourcePath: string,
  outputPath?: string,
  title?: string,
): Promise<PdfExportResult> {
  const normalizedSource = normalizeWorkspacePath(sourcePath)
  const normalizedOutput = normalizeWorkspacePath(outputPath || defaultPdfPath(normalizedSource))

  if (!isSafeWorkspacePath(normalizedSource) || !isSafeWorkspacePath(normalizedOutput)) {
    return {
      action: 'exported',
      path: normalizedOutput,
      content: 'Error: path traversal not allowed',
      error: 'path traversal not allowed',
    }
  }

  if (!normalizedOutput.toLowerCase().endsWith('.pdf')) {
    return {
      action: 'exported',
      path: normalizedOutput,
      content: 'Error: output path must end in .pdf',
      error: 'output path must end in .pdf',
    }
  }

  const sourceRead = await readSandboxFileBytes(conversationId, normalizedSource)
  if (!sourceRead.ok) {
    return {
      action: 'exported',
      path: normalizedOutput,
      content: 'Error: source file not found',
      error: 'source file not found',
    }
  }

  const source = new TextDecoder().decode(sourceRead.body)

  const sourceExt = extname(normalizedSource).toLowerCase()
  const htmlBody = sourceExt === '.html' || sourceExt === '.htm'
    ? source
    : `<main>${markdownToHtml(source)}</main>`
  const html = wrapHtml(
    htmlBody,
    title || normalizedSource.split('/').pop(),
    sourceExt === '.html' || sourceExt === '.htm',
  )

  try {
    const { renderDocumentPdf } = await import('./browser')
    const rendered = await renderDocumentPdf(conversationId, html)
    const pdfBuffer = rendered.bytes

    const pdfHeader = String.fromCharCode(...pdfBuffer.subarray(0, 5))
    if (pdfBuffer.length < 512 || pdfHeader !== '%PDF-') {
      return {
        action: 'exported',
        path: normalizedOutput,
        content: 'Error: PDF renderer returned an invalid or empty document',
        error: 'PDF renderer returned an invalid or empty document',
      }
    }

    await writeSandboxFileBytes(conversationId, normalizedOutput, pdfBuffer)
    return {
      action: 'exported',
      path: normalizedOutput,
      size: pdfBuffer.byteLength,
      validated: true,
      validation: 'PDF signature, non-empty rendered preview, readable text, white print background and overflow-free page layout validated before durable save',
      pageSize: 'A4',
      renderValidation: {
        textCharacters: rendered.validation.textCharacters,
        headingCount: rendered.validation.headingCount,
        linkCount: rendered.validation.linkCount,
        tableCount: rendered.validation.tableCount,
        horizontalOverflow: rendered.validation.horizontalOverflow,
        bodyBackground: rendered.validation.bodyBackground,
        previewNonBlank: rendered.validation.screenshotQuality?.blank !== true,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      action: 'exported',
      path: normalizedOutput,
      content: `Error: PDF export failed: ${message}`,
      error: `PDF export failed: ${message}`,
    }
  }
}
