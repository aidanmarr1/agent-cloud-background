const DOCUMENT_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const DOCUMENT_EXTENSIONS = new Set(['docx', 'pptx'])

export function getAttachmentExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase().split('?')[0] || ''
}

export function isExtractableDocument(fileName: string, mimeType: string): boolean {
  return DOCUMENT_MIME_TYPES.has(mimeType) || DOCUMENT_EXTENSIONS.has(getAttachmentExtension(fileName))
}
