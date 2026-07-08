'use client'

import { Archive, BookOpen, CheckCircle2, FileCode, FileText, FolderOpen, X } from '@/components/icons'
import type { FileAttachment } from '@/types'
import { ARCHIVE_ATTACHMENT_TYPE, formatBytes, SKILL_ATTACHMENT_TYPE } from '@/lib/fileHandling'

const CODE_ATTACHMENT_EXTENSIONS = new Set([
  'css', 'html', 'js', 'jsx', 'ts', 'tsx', 'json', 'md', 'py', 'rs', 'go', 'java', 'swift', 'sql', 'sh', 'toml', 'yaml', 'yml',
])

function getAttachmentExtension(name: string): string {
  const filename = name.split('/').pop() || name
  if (!filename.includes('.')) return ''
  return filename.split('.').pop()?.toLowerCase() || ''
}

export function getAttachmentKey(attachment: FileAttachment): string {
  return `${attachment.name}:${attachment.type}:${attachment.size}:${attachment.content?.slice(0, 48) ?? ''}`
}

function isFolderAttachment(attachment: FileAttachment): boolean {
  return attachment.type === ARCHIVE_ATTACHMENT_TYPE && attachment.name.endsWith(' (folder)')
}

function getAttachmentKind(attachment: FileAttachment): string {
  if (attachment.type === SKILL_ATTACHMENT_TYPE) return 'Skill'
  if (isFolderAttachment(attachment)) return 'Folder'
  if (attachment.type === ARCHIVE_ATTACHMENT_TYPE) return 'Archive'
  if (CODE_ATTACHMENT_EXTENSIONS.has(getAttachmentExtension(attachment.name))) return 'Code'
  return 'File'
}

function AttachmentIcon({ attachment }: { attachment: FileAttachment }) {
  const className = 'text-text-muted'
  if (attachment.type === SKILL_ATTACHMENT_TYPE) return <BookOpen size={15} className={className} strokeWidth={2.2} />
  if (isFolderAttachment(attachment)) return <FolderOpen size={15} className={className} strokeWidth={2.2} />
  if (attachment.type === ARCHIVE_ATTACHMENT_TYPE) return <Archive size={15} className={className} strokeWidth={2.2} />
  if (CODE_ATTACHMENT_EXTENSIONS.has(getAttachmentExtension(attachment.name))) return <FileCode size={15} className={className} strokeWidth={2.2} />
  return <FileText size={15} className={className} strokeWidth={2.2} />
}

interface AttachmentPreviewRowProps {
  attachment: FileAttachment
  onRemove?: () => void
  showReady?: boolean
  density?: 'input' | 'message'
}

export function AttachmentPreviewRow({
  attachment,
  onRemove,
  showReady = false,
  density = 'input',
}: AttachmentPreviewRowProps) {
  const compact = density === 'message'

  return (
    <div
      className={`group flex items-center gap-2 rounded-lg border border-transparent bg-bg-primary px-2 text-[12px] text-text-secondary transition-colors duration-150 hover:border-border-secondary hover:bg-bg-secondary ${
        compact ? 'min-h-10' : 'min-h-11 animate-scale-in'
      }`}
    >
      <div className={`flex flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-primary bg-bg-secondary ${
        compact ? 'h-7 w-7' : 'h-8 w-8'
      }`}>
        <AttachmentIcon attachment={attachment} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-text-secondary">{attachment.name}</div>
        <div className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
          <span>{getAttachmentKind(attachment)}</span>
          <span className="h-0.5 w-0.5 rounded-full bg-text-muted/70" />
          <span>{formatBytes(attachment.size)}</span>
        </div>
      </div>
      {showReady && (
        <div className="hidden items-center gap-1 text-[10.5px] font-medium text-text-secondary sm:flex">
          <CheckCircle2 size={11} strokeWidth={2.2} />
          Ready
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-all duration-150 hover:bg-bg-secondary hover:text-text-primary"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
