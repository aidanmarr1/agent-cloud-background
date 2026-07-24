'use client'

import { Archive, BookOpen, FileCode, FileText, FolderOpen, X } from '@/components/icons'
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

function AttachmentIcon({ attachment, size = 17 }: { attachment: FileAttachment; size?: number }) {
  const className = 'text-text-muted'
  if (attachment.type === SKILL_ATTACHMENT_TYPE) return <BookOpen size={size} className={className} strokeWidth={2.2} />
  if (isFolderAttachment(attachment)) return <FolderOpen size={size} className={className} strokeWidth={2.2} />
  if (attachment.type === ARCHIVE_ATTACHMENT_TYPE) return <Archive size={size} className={className} strokeWidth={2.2} />
  if (CODE_ATTACHMENT_EXTENSIONS.has(getAttachmentExtension(attachment.name))) return <FileCode size={size} className={className} strokeWidth={2.2} />
  return <FileText size={size} className={className} strokeWidth={2.2} />
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
  const previewSource = attachment.type.startsWith('image/')
    ? attachment.preview || attachment.url || (attachment.contentEncoding === 'data-url' ? attachment.content : undefined)
    : undefined

  return (
    <div
      aria-label={showReady ? `${attachment.name}, ready` : attachment.name}
      className={`group relative flex flex-shrink-0 items-center gap-3 overflow-hidden rounded-xl border border-border-primary bg-bg-primary text-text-secondary transition-colors duration-150 hover:border-border-tertiary ${
        compact
          ? 'h-14 min-w-[210px] max-w-[270px] px-2.5'
          : 'h-[66px] w-[278px] flex-none px-3 pr-9 animate-scale-in'
      }`}
    >
      <div className={`flex flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-primary bg-bg-secondary ${
        compact ? 'h-9 w-9' : 'h-10 w-10'
      }`}>
        {previewSource ? (
          <img src={previewSource} alt="" className="h-full w-full object-cover" />
        ) : (
          <AttachmentIcon attachment={attachment} size={compact ? 16 : 18} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`${compact ? 'text-[12px]' : 'text-[13px]'} truncate font-semibold text-text-primary`}>{attachment.name}</div>
        <div className={`${compact ? 'text-[10px]' : 'text-[11px]'} mt-0.5 flex items-center gap-1.5 text-text-muted`}>
          <span>{getAttachmentKind(attachment)}</span>
          <span className="h-0.5 w-0.5 rounded-full bg-text-muted/70" />
          <span>{formatBytes(attachment.size)}</span>
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          className="absolute right-2 top-2 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-bg-primary text-text-muted opacity-100 transition-[background-color,color,opacity] duration-150 hover:bg-bg-secondary hover:text-text-primary sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
