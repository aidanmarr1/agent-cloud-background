'use client'

import { Code, Database, File, FileText, ImageIcon } from '@/components/icons'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'])
const CODE_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'sh', 'sql'])
const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'rtf'])
const DATA_EXTENSIONS = new Set(['json', 'csv', 'xml', 'yaml', 'yml', 'xlsx', 'xls'])

type FileCategory = 'image' | 'code' | 'document' | 'data' | 'other'

function extensionFor(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

export function categoryForFileName(name: string): FileCategory {
  const ext = extensionFor(name)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document'
  if (DATA_EXTENSIONS.has(ext)) return 'data'
  return 'other'
}

function FileIcon({ name }: { name: string }) {
  const category = categoryForFileName(name)
  if (category === 'image') return <ImageIcon size={15} className="text-current" strokeWidth={2.15} />
  if (category === 'code') return <Code size={15} className="text-current" strokeWidth={2.15} />
  if (category === 'data') return <Database size={15} className="text-current" strokeWidth={2.15} />
  if (category === 'document') return <FileText size={15} className="text-current" strokeWidth={2.15} />
  return <File size={15} className="text-current" strokeWidth={2.15} />
}

export function FileBadge({ name, large = false }: { name: string; large?: boolean }) {
  const category = categoryForFileName(name)
  const highlighted = category === 'document' || category === 'image'
  return (
    <div
      className={`${large ? 'h-9 w-9 rounded-lg' : 'h-9 w-9 rounded-lg'} flex flex-shrink-0 items-center justify-center border ${
        highlighted
          ? 'border-transparent bg-[var(--status-live)] text-text-on-accent'
          : 'border-border-primary bg-bg-secondary text-text-muted'
      }`}
    >
      <FileIcon name={name} />
    </div>
  )
}
