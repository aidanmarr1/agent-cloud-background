import type { FileAttachment, SavedSkill } from '@/types'

export const MAX_FILE_SIZE = 10 * 1024 * 1024
export const MAX_DOCUMENT_SIZE = 25 * 1024 * 1024
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024
export const MAX_IMPORTED_SKILL_CHARS = 120_000
export const SKILL_ATTACHMENT_TYPE = 'application/x-agent-skill'
export const ARCHIVE_ATTACHMENT_TYPE = 'application/vnd.agent.archive-text'

const MAX_IMAGE_DATA_URL_CHARS = 2_750_000
const MAX_IMAGE_DIMENSION = 1800
const MAX_ARCHIVE_ENTRY_CHARS = 40_000
const MAX_ARCHIVE_TOTAL_CHARS = 140_000

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'text/xml',
  'text/markdown',
  'application/x-yaml',
  'text/yaml',
])

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'skill',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cpp',
  'cc',
  'h',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'sql',
  'toml',
  'ini',
  'cfg',
  'env',
  'log',
  'diff',
  'patch',
  'gitignore',
])

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/rtf',
  'text/rtf',
])

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'rtf'])

const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  rtf: 'application/rtf',
}

export const TEXT_ACCEPT = '.txt,.md,.markdown,.skill,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.mjs,.cjs,.ts,.jsx,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.cpp,.cc,.h,.hpp,.sh,.sql,.toml,.ini,.cfg,.env,.log,.diff,.patch'
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif'
export const DOCUMENT_ACCEPT = 'application/pdf,application/rtf,text/rtf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.docx,.pptx,.xlsx,.rtf'
export const ARCHIVE_ACCEPT = '.zip,application/zip,application/x-zip-compressed'
export const FILE_ACCEPT = `${TEXT_ACCEPT},${IMAGE_ACCEPT},${DOCUMENT_ACCEPT},${ARCHIVE_ACCEPT}`
export const SKILL_IMPORT_ACCEPT = '.skill,.md,.markdown,.txt,.zip,application/zip,application/x-zip-compressed'

interface TextEntry {
  path: string
  content: string
  size: number
}

interface ExtractionResult {
  entries: TextEntry[]
  warnings: string[]
  truncated: boolean
}

export interface FileProcessingResult {
  attachments: FileAttachment[]
  errors: string[]
  warnings: string[]
}

export interface SkillImportDraft {
  name: string
  description: string
  content: string
  sourceName: string
  sourceType: SavedSkill['sourceType']
  fileCount: number
  size: number
}

export interface SkillImportResult {
  skills: SkillImportDraft[]
  errors: string[]
  warnings: string[]
}

export function getFileExtension(fileName: string): string {
  const name = fileName.split('/').pop() || fileName
  if (!name.includes('.')) return ''
  return name.split('.').pop()?.toLowerCase() || ''
}

export function isTextFile(file: File): boolean {
  if (TEXT_MIME_TYPES.has(file.type)) return true
  return TEXT_EXTENSIONS.has(getFileExtension(file.name))
}

export function isArchiveFile(file: File): boolean {
  return getFileExtension(file.name) === 'zip' ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
}

export function getDocumentMimeType(file: File): string | null {
  if (DOCUMENT_MIME_TYPES.has(file.type)) return file.type
  return DOCUMENT_MIME_BY_EXTENSION[getFileExtension(file.name)] ?? null
}

export function isDocumentFile(file: File): boolean {
  return getDocumentMimeType(file) !== null || DOCUMENT_EXTENSIONS.has(getFileExtension(file.name))
}

export function getImageMimeType(file: File): string | null {
  if (file.type.startsWith('image/')) return file.type
  return IMAGE_MIME_BY_EXTENSION[getFileExtension(file.name)] ?? null
}

export function normalizeImageDataUrl(dataUrl: string, mimeType: string): string {
  return dataUrl.replace(/^data:[^;,]*(;base64,)/, `data:${mimeType}$1`)
}

export function isImageFile(file: File): boolean {
  return getImageMimeType(file) !== null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function mimeTypeFromDataUrl(dataUrl: string): string | null {
  return dataUrl.match(/^data:([^;,]+)/)?.[1] || null
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not decode image'))
    image.src = dataUrl
  })
}

function canvasToDataUrl(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<string> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(canvas.toDataURL('image/jpeg', quality))
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(blob)
    }, mimeType, quality)
  })
}

async function createImageAttachmentContent(file: File, mimeType: string): Promise<{
  content: string
  type: string
  compressed: boolean
}> {
  const original = normalizeImageDataUrl(await readFileAsDataURL(file), mimeType)

  if (typeof document === 'undefined') {
    return { content: original, type: mimeType, compressed: false }
  }

  let image: HTMLImageElement
  try {
    image = await loadImage(original)
  } catch {
    return { content: original, type: mimeType, compressed: false }
  }

  const largestSide = Math.max(image.naturalWidth, image.naturalHeight)
  if (original.length <= MAX_IMAGE_DATA_URL_CHARS && largestSide <= MAX_IMAGE_DIMENSION) {
    return { content: original, type: mimeType, compressed: false }
  }

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) {
    return { content: original, type: mimeType, compressed: false }
  }

  const targetMimeTypes = mimeType === 'image/gif'
    ? ['image/jpeg']
    : ['image/webp', 'image/jpeg']
  const qualitySteps = [0.88, 0.78, 0.68, 0.58]
  let scale = Math.min(1, MAX_IMAGE_DIMENSION / largestSide)
  let best = original
  let bestType = mimeType

  for (let resizeAttempt = 0; resizeAttempt < 5; resizeAttempt++) {
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))

    for (const targetType of targetMimeTypes) {
      context.clearRect(0, 0, canvas.width, canvas.height)
      if (targetType === 'image/jpeg') {
        context.fillStyle = '#f5f5f5'
        context.fillRect(0, 0, canvas.width, canvas.height)
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)

      for (const quality of qualitySteps) {
        const next = await canvasToDataUrl(canvas, targetType, quality)
        const nextType = mimeTypeFromDataUrl(next) || targetType
        if (next.length < best.length) {
          best = next
          bestType = nextType
        }
        if (next.length <= MAX_IMAGE_DATA_URL_CHARS) {
          return { content: next, type: nextType, compressed: true }
        }
      }
    }

    const shrinkRatio = Math.sqrt(MAX_IMAGE_DATA_URL_CHARS / Math.max(best.length, 1))
    scale = Math.max(0.2, scale * Math.min(0.85, shrinkRatio * 0.92))
  }

  return { content: best, type: bestType, compressed: best !== original }
}

function getRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

function trimToLimit(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false }
  return {
    value: `${value.slice(0, limit)}\n... [truncated from ${value.length} characters]`,
    truncated: true,
  }
}

function stripOuterQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').trim()
}

function titleFromFileName(fileName: string): string {
  const baseName = fileName.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Untitled skill'
  return baseName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Untitled skill'
}

function deriveSkillMetadata(sourceName: string, content: string): Pick<SkillImportDraft, 'name' | 'description'> {
  const trimmed = content.trim()

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { name?: unknown; title?: unknown; description?: unknown }
      const name = typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.title === 'string'
          ? parsed.title
          : ''
      const description = typeof parsed.description === 'string' ? parsed.description : ''
      if (name || description) {
        return {
          name: name.trim() || titleFromFileName(sourceName),
          description: description.trim() || 'Saved reusable skill',
        }
      }
    } catch {
      // Fall through to markdown/frontmatter parsing.
    }
  }

  const frontmatter = trimmed.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]
    const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]
    if (name || description) {
      return {
        name: name ? stripOuterQuotes(name) : titleFromFileName(sourceName),
        description: description ? stripOuterQuotes(description) : 'Saved reusable skill',
      }
    }
  }

  const heading = trimmed.match(/^#\s+(.+)$/m)?.[1]
  const firstBodyLine = trimmed
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('---'))

  return {
    name: heading?.trim() || titleFromFileName(sourceName),
    description: firstBodyLine?.slice(0, 140) || 'Saved reusable skill',
  }
}

function looksBinary(text: string): boolean {
  const sample = text.slice(0, 2048)
  return sample.includes('\u0000')
}

function isTextEntryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  if (!normalized || normalized.endsWith('/')) return false
  if (normalized.startsWith('__MACOSX/') || normalized.endsWith('/.DS_Store')) return false
  const name = normalized.split('/').pop() || ''
  if (name === '.DS_Store') return false
  const ext = getFileExtension(normalized)
  return TEXT_EXTENSIONS.has(ext) || name === 'README' || name === 'AGENTS'
}

function formatTextEntries(sourceLabel: string, entries: TextEntry[], warnings: string[], maxChars: number): { content: string; truncated: boolean } {
  let truncated = false
  const sections = [
    `Source: ${sourceLabel}`,
    `Extracted text files: ${entries.length}`,
  ]

  if (warnings.length > 0) {
    sections.push(`Skipped or limited files: ${warnings.join('; ')}`)
  }

  let remaining = Math.max(0, maxChars - sections.join('\n').length)
  for (const entry of entries) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    const header = `\n\n--- File: ${entry.path} ---\n`
    const footer = `\n--- End of ${entry.path} ---`
    const entryBudget = Math.min(MAX_ARCHIVE_ENTRY_CHARS, Math.max(0, remaining - header.length - footer.length))
    if (entryBudget <= 0) {
      truncated = true
      break
    }
    const trimmed = trimToLimit(entry.content, entryBudget)
    truncated = truncated || trimmed.truncated
    const block = `${header}${trimmed.value}${footer}`
    sections.push(block)
    remaining -= block.length
  }

  if (truncated) {
    sections.push('\n... [archive content truncated]')
  }

  return { content: sections.join('\n'), truncated }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - 66_000)
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  return -1
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Zip deflate is not supported in this browser')
  }
  const dataCopy = new Uint8Array(data.byteLength)
  dataCopy.set(data)
  const stream = new Blob([dataCopy.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

async function readZipTextEntries(file: File): Promise<ExtractionResult> {
  const warnings: string[] = []
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = findEndOfCentralDirectory(view)
  if (eocdOffset < 0) {
    throw new Error('Could not read zip directory')
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const entries: TextEntry[] = []
  let offset = centralDirectoryOffset
  let truncated = false
  let totalChars = 0

  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      warnings.push('Stopped early because the zip directory is malformed')
      break
    }

    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + fileNameLength)).replace(/\\/g, '/')
    offset += 46 + fileNameLength + extraLength + commentLength

    if (!isTextEntryPath(path)) continue
    if ((flags & 1) === 1) {
      warnings.push(`${path} is encrypted`)
      continue
    }
    if (method !== 0 && method !== 8) {
      warnings.push(`${path} uses an unsupported zip compression method`)
      continue
    }
    if (uncompressedSize > MAX_FILE_SIZE) {
      warnings.push(`${path} is larger than ${formatBytes(MAX_FILE_SIZE)}`)
      continue
    }
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      warnings.push(`${path} has an invalid local header`)
      continue
    }

    const localNameLength = view.getUint16(localHeaderOffset + 26, true)
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
    const inflated = method === 0 ? compressed : await inflateRaw(compressed)
    const content = decoder.decode(inflated)
    if (looksBinary(content)) {
      warnings.push(`${path} appears to be binary`)
      continue
    }

    const limited = trimToLimit(content, MAX_ARCHIVE_ENTRY_CHARS)
    truncated = truncated || limited.truncated
    entries.push({ path, content: limited.value, size: uncompressedSize })
    totalChars += limited.value.length
    if (totalChars >= MAX_ARCHIVE_TOTAL_CHARS) {
      truncated = true
      break
    }
  }

  return { entries, warnings, truncated }
}

async function readFolderTextEntries(files: File[]): Promise<ExtractionResult> {
  const warnings: string[] = []
  const entries: TextEntry[] = []
  let truncated = false
  let totalChars = 0

  for (const file of files.sort((a, b) => getRelativePath(a).localeCompare(getRelativePath(b)))) {
    const path = getRelativePath(file).replace(/\\/g, '/')
    if (!isTextEntryPath(path)) continue
    if (file.size > MAX_FILE_SIZE) {
      warnings.push(`${path} is larger than ${formatBytes(MAX_FILE_SIZE)}`)
      continue
    }
    const content = await readFileAsText(file)
    if (looksBinary(content)) {
      warnings.push(`${path} appears to be binary`)
      continue
    }
    const limited = trimToLimit(content, MAX_ARCHIVE_ENTRY_CHARS)
    truncated = truncated || limited.truncated
    entries.push({ path, content: limited.value, size: file.size })
    totalChars += limited.value.length
    if (totalChars >= MAX_ARCHIVE_TOTAL_CHARS) {
      truncated = true
      break
    }
  }

  return { entries, warnings, truncated }
}

function findPrimarySkillContent(entries: TextEntry[], fallback: string): string {
  const prioritized = entries.find((entry) => /(^|\/)SKILL\.md$/i.test(entry.path)) ||
    entries.find((entry) => /\.skill$/i.test(entry.path)) ||
    entries.find((entry) => /(^|\/)README\.md$/i.test(entry.path))
  return prioritized?.content || fallback
}

function rootFolderName(files: File[]): string {
  const first = files[0] ? getRelativePath(files[0]).split('/')[0] : ''
  return first || 'Uploaded folder'
}

function isFolderSelection(files: File[]): boolean {
  return files.some((file) => getRelativePath(file).includes('/'))
}

async function createFolderAttachment(files: File[]): Promise<{ attachment: FileAttachment; warnings: string[] }> {
  const sourceName = rootFolderName(files)
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)

  if (totalSize > MAX_FILE_SIZE) {
    throw new Error(`Folder is larger than ${formatBytes(MAX_FILE_SIZE)}`)
  }

  const extraction = await readFolderTextEntries(files)
  if (extraction.entries.length === 0) {
    throw new Error(`No readable text files found in "${sourceName}"`)
  }

  const formatted = formatTextEntries(sourceName, extraction.entries, extraction.warnings, MAX_ARCHIVE_TOTAL_CHARS)
  return {
    attachment: {
      name: `${sourceName} (folder)`,
      type: ARCHIVE_ATTACHMENT_TYPE,
      size: totalSize,
      content: formatted.content,
    },
    warnings: [
      ...extraction.warnings,
      ...(extraction.truncated || formatted.truncated ? [`Folder "${sourceName}" was truncated`] : []),
    ],
  }
}

async function createSkillFromTextFile(file: File): Promise<SkillImportDraft> {
  const content = await readFileAsText(file)
  const limited = trimToLimit(content, MAX_IMPORTED_SKILL_CHARS)
  const metadata = deriveSkillMetadata(file.name, limited.value)
  return {
    ...metadata,
    content: limited.value,
    sourceName: file.name,
    sourceType: getFileExtension(file.name) === 'skill' ? 'skill' : 'text',
    fileCount: 1,
    size: file.size,
  }
}

async function createSkillFromZip(file: File): Promise<{ skill: SkillImportDraft; warnings: string[] }> {
  const extraction = await readZipTextEntries(file)
  if (extraction.entries.length === 0) {
    throw new Error('No readable text files found in zip')
  }
  const formatted = formatTextEntries(file.name, extraction.entries, extraction.warnings, MAX_IMPORTED_SKILL_CHARS)
  const metadata = deriveSkillMetadata(file.name, findPrimarySkillContent(extraction.entries, formatted.content))
  return {
    skill: {
      ...metadata,
      content: formatted.content,
      sourceName: file.name,
      sourceType: 'zip',
      fileCount: extraction.entries.length,
      size: file.size,
    },
    warnings: [
      ...extraction.warnings,
      ...(extraction.truncated || formatted.truncated ? [`${file.name} was truncated to fit the skill library`] : []),
    ],
  }
}

async function createSkillFromFolder(files: File[]): Promise<{ skill: SkillImportDraft; warnings: string[] }> {
  const sourceName = rootFolderName(files)
  const extraction = await readFolderTextEntries(files)
  if (extraction.entries.length === 0) {
    throw new Error('No readable text files found in folder')
  }
  const formatted = formatTextEntries(sourceName, extraction.entries, extraction.warnings, MAX_IMPORTED_SKILL_CHARS)
  const metadata = deriveSkillMetadata(sourceName, findPrimarySkillContent(extraction.entries, formatted.content))
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  return {
    skill: {
      ...metadata,
      content: formatted.content,
      sourceName,
      sourceType: 'folder',
      fileCount: extraction.entries.length,
      size: totalSize,
    },
    warnings: [
      ...extraction.warnings,
      ...(extraction.truncated || formatted.truncated ? [`${sourceName} was truncated to fit the skill library`] : []),
    ],
  }
}

export async function processFilesForAttachments(files: FileList | File[]): Promise<FileProcessingResult> {
  const list = Array.from(files)
  const attachments: FileAttachment[] = []
  const errors: string[] = []
  const warnings: string[] = []

  if (list.length === 0) return { attachments, errors, warnings }

  if (isFolderSelection(list)) {
    try {
      const folder = await createFolderAttachment(list)
      attachments.push(folder.attachment)
      warnings.push(...folder.warnings)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read folder'
      errors.push(message)
    }
    return { attachments, errors, warnings }
  }

  for (const file of list) {
    try {
      const imageType = getImageMimeType(file)

      if (imageType) {
        if (file.size > MAX_IMAGE_SIZE) {
          errors.push(`Image "${file.name}" too large (max ${formatBytes(MAX_IMAGE_SIZE)})`)
          continue
        }
        const image = await createImageAttachmentContent(file, imageType)
        if (image.compressed) {
          warnings.push(`Image "${file.name}" was resized for upload`)
        }
        attachments.push({
          name: file.name,
          type: image.type,
          size: file.size,
          content: image.content,
        })
      } else if (isArchiveFile(file)) {
        if (file.size > MAX_FILE_SIZE) {
          errors.push(`Archive "${file.name}" too large (max ${formatBytes(MAX_FILE_SIZE)})`)
          continue
        }
        const extraction = await readZipTextEntries(file)
        if (extraction.entries.length === 0) {
          errors.push(`No readable text files found in "${file.name}"`)
          continue
        }
        const formatted = formatTextEntries(file.name, extraction.entries, extraction.warnings, MAX_ARCHIVE_TOTAL_CHARS)
        warnings.push(...extraction.warnings)
        if (extraction.truncated || formatted.truncated) {
          warnings.push(`Archive "${file.name}" was truncated`)
        }
        attachments.push({
          name: `${file.name} (extracted)`,
          type: ARCHIVE_ATTACHMENT_TYPE,
          size: file.size,
          content: formatted.content,
        })
      } else if (isTextFile(file)) {
        if (file.size > MAX_FILE_SIZE) {
          errors.push(`File "${file.name}" too large (max ${formatBytes(MAX_FILE_SIZE)})`)
          continue
        }
        const content = await readFileAsText(file)
        attachments.push({
          name: file.name,
          type: getFileExtension(file.name) === 'skill' ? SKILL_ATTACHMENT_TYPE : file.type || 'text/plain',
          size: file.size,
          content,
        })
      } else if (isDocumentFile(file)) {
        const documentType = getDocumentMimeType(file) || file.type || 'application/octet-stream'
        if (file.size > MAX_DOCUMENT_SIZE) {
          errors.push(`Document "${file.name}" too large (max ${formatBytes(MAX_DOCUMENT_SIZE)})`)
          continue
        }
        attachments.push({
          name: file.name,
          type: documentType,
          size: file.size,
          content: await readFileAsDataURL(file),
          contentEncoding: 'data-url',
        })
      } else {
        errors.push(`Unsupported file type: ${file.name}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read file'
      errors.push(`Failed to read "${file.name}": ${message}`)
    }
  }

  return { attachments, errors, warnings }
}

export async function readSkillImportsFromFiles(files: FileList | File[]): Promise<SkillImportResult> {
  const list = Array.from(files)
  const skills: SkillImportDraft[] = []
  const errors: string[] = []
  const warnings: string[] = []

  if (list.length === 0) return { skills, errors, warnings }

  try {
    if (isFolderSelection(list)) {
      const folderSkill = await createSkillFromFolder(list)
      skills.push(folderSkill.skill)
      warnings.push(...folderSkill.warnings)
      return { skills, errors, warnings }
    }

    for (const file of list) {
      try {
        if (isArchiveFile(file)) {
          if (file.size > MAX_FILE_SIZE) {
            errors.push(`Archive "${file.name}" too large (max ${formatBytes(MAX_FILE_SIZE)})`)
            continue
          }
          const zipSkill = await createSkillFromZip(file)
          skills.push(zipSkill.skill)
          warnings.push(...zipSkill.warnings)
        } else if (isTextFile(file)) {
          if (file.size > MAX_FILE_SIZE) {
            errors.push(`File "${file.name}" too large (max ${formatBytes(MAX_FILE_SIZE)})`)
            continue
          }
          skills.push(await createSkillFromTextFile(file))
        } else {
          errors.push(`Unsupported skill file: ${file.name}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not import skill'
        errors.push(`Could not import "${file.name}": ${message}`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not import skills'
    errors.push(message)
  }

  return { skills, errors, warnings }
}

export function createSkillAttachment(skill: SavedSkill): FileAttachment {
  const content = [
    `Selected skill: ${skill.name}`,
    skill.description ? `Description: ${skill.description}` : '',
    `Source: ${skill.sourceName}`,
    '',
    'Read this skill before responding or taking action. Apply the relevant instructions to the user request.',
    '',
    skill.content,
  ].filter(Boolean).join('\n')

  return {
    name: `${skill.name}.skill`,
    type: SKILL_ATTACHMENT_TYPE,
    size: new Blob([content]).size,
    content,
  }
}
