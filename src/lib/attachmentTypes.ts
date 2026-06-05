const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/rtf',
  'text/rtf',
])

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'rtf'])

export function getAttachmentExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase().split('?')[0] || ''
}

export function isExtractableDocument(fileName: string, mimeType: string): boolean {
  return DOCUMENT_MIME_TYPES.has(mimeType) || DOCUMENT_EXTENSIONS.has(getAttachmentExtension(fileName))
}
