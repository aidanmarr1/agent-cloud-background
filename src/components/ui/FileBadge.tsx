'use client'

import { Code, Database, File, FileText, ImageIcon } from '@/components/icons'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'])
const CODE_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'sh', 'sql'])
const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'ppt', 'pptx'])
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

function FileIcon({ name, size = 15 }: { name: string; size?: number }) {
  const category = categoryForFileName(name)
  if (category === 'image') return <ImageIcon size={size} className="text-current" strokeWidth={2.15} />
  if (category === 'code') return <Code size={size} className="text-current" strokeWidth={2.15} />
  if (category === 'data') return <Database size={size} className="text-current" strokeWidth={2.15} />
  if (category === 'document') return <FileText size={size} className="text-current" strokeWidth={2.15} />
  return <File size={size} className="text-current" strokeWidth={2.15} />
}

export function FileBadge({ name, large = false }: { name: string; large?: boolean }) {
  const extension = extensionFor(name)
  const category = categoryForFileName(name)
  const colorClass = extension === 'pdf'
    ? 'border-transparent bg-[#d84f5b] text-white'
    : category === 'document'
      ? 'border-transparent bg-[#4f78d1] text-white'
      : 'border-border-primary bg-bg-tertiary text-text-muted'

  return (
    <div
      className={`${large ? 'h-10 w-10 rounded-[10px]' : 'h-9 w-9 rounded-lg'} flex flex-shrink-0 items-center justify-center border ${colorClass}`}
    >
      <FileIcon name={name} size={large ? 17 : 15} />
    </div>
  )
}
