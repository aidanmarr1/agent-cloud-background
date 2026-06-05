import { inflateRawSync } from 'zlib'
import { getAttachmentExtension, isExtractableDocument } from '@/lib/attachmentTypes'

export const MAX_EXTRACTED_ATTACHMENT_CHARS = 120_000
const MAX_ZIP_ENTRY_BYTES = 2_000_000
const MAX_ZIP_TOTAL_BYTES = 8_000_000

export { isExtractableDocument }

interface ExtractedAttachmentText {
  content: string
  truncated: boolean
}

interface ZipTextEntry {
  path: string
  text: string
}

declare const __non_webpack_require__: NodeRequire | undefined

function runtimeRequire<T>(specifier: string): T {
  const req = typeof __non_webpack_require__ === 'function'
    ? __non_webpack_require__
    : (eval('require') as NodeRequire)
  return req(specifier) as T
}

function trimExtractedText(text: string): ExtractedAttachmentText | null {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

  if (!normalized) return null

  if (normalized.length <= MAX_EXTRACTED_ATTACHMENT_CHARS) {
    return { content: normalized, truncated: false }
  }

  return {
    content: `${normalized.slice(0, MAX_EXTRACTED_ATTACHMENT_CHARS)}\n... [truncated from ${normalized.length} characters]`,
    truncated: true,
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

function extractTextFromXml(xml: string): string {
  const textNodes = [...xml.matchAll(/<[^:>]*:?t\b[^>]*>([\s\S]*?)<\/[^:>]*:?t>/g)]
    .map((match) => decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')))
    .map((text) => text.trim())
    .filter(Boolean)

  if (textNodes.length > 0) return textNodes.join('\n')

  return decodeXmlEntities(xml.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function stripRtf(text: string): string {
  return text
    .replace(/\\'[0-9a-f]{2}/gi, ' ')
    .replace(/\\[a-z]+\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 66_000)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function inflateRawCapped(compressed: Buffer, maxBytes: number): Buffer | null {
  try {
    const inflated = inflateRawSync(compressed, { maxOutputLength: maxBytes + 1 } as Parameters<typeof inflateRawSync>[1])
    return inflated.byteLength <= maxBytes ? inflated : null
  } catch {
    return null
  }
}

function readZipTextEntries(buffer: Buffer, includePath: (path: string) => boolean): ZipTextEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset < 0) return []

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)
  const entries: ZipTextEntry[] = []
  let totalInflatedBytes = 0

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break

    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const path = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString('utf8')
      .replace(/\\/g, '/')

    offset += 46 + fileNameLength + extraLength + commentLength

    if (!includePath(path) || (flags & 1) === 1 || (method !== 0 && method !== 8) || uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      continue
    }
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      continue
    }

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    if (dataStart < 0 || dataStart + compressedSize > buffer.length) {
      continue
    }
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0
      ? (compressed.byteLength <= MAX_ZIP_ENTRY_BYTES ? compressed : null)
      : inflateRawCapped(compressed, MAX_ZIP_ENTRY_BYTES)
    if (!data) continue
    totalInflatedBytes += data.byteLength
    if (totalInflatedBytes > MAX_ZIP_TOTAL_BYTES) break
    const text = data.toString('utf8')
    if (text.includes('\u0000')) continue
    entries.push({ path, text })
  }

  return entries
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const pdfParse = runtimeRequire<(buf: Buffer) => Promise<{ text: string }>>('pdf-parse')
  const data = await pdfParse(buffer)
  return data.text
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = runtimeRequire<{
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>
  }>('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

function parsePptx(buffer: Buffer): string {
  const entries = readZipTextEntries(buffer, (path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
  return entries
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map((entry) => `Slide ${entry.path.match(/slide(\d+)\.xml$/i)?.[1] || ''}\n${extractTextFromXml(entry.text)}`.trim())
    .filter(Boolean)
    .join('\n\n')
}

function parseXlsx(buffer: Buffer): string {
  const entries = readZipTextEntries(buffer, (path) =>
    /^xl\/sharedStrings\.xml$/i.test(path) || /^xl\/worksheets\/sheet\d+\.xml$/i.test(path)
  )
  return entries
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map((entry) => `${entry.path}\n${extractTextFromXml(entry.text)}`.trim())
    .filter(Boolean)
    .join('\n\n')
}

export async function extractUploadedAttachmentText(input: {
  fileName: string
  mimeType: string
  body: Buffer
}): Promise<ExtractedAttachmentText | null> {
  const ext = getAttachmentExtension(input.fileName)
  const mimeType = input.mimeType.toLowerCase()

  try {
    if (mimeType === 'application/pdf' || ext === 'pdf') {
      return trimExtractedText(await parsePdf(input.body))
    }
    if (mimeType.includes('wordprocessingml') || ext === 'docx') {
      return trimExtractedText(await parseDocx(input.body))
    }
    if (mimeType.includes('presentationml') || ext === 'pptx') {
      return trimExtractedText(parsePptx(input.body))
    }
    if (mimeType.includes('spreadsheetml') || ext === 'xlsx') {
      return trimExtractedText(parseXlsx(input.body))
    }
    if (mimeType === 'application/rtf' || mimeType === 'text/rtf' || ext === 'rtf') {
      return trimExtractedText(stripRtf(input.body.toString('utf8')))
    }
  } catch {
    return null
  }

  return null
}
