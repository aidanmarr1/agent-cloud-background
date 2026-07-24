'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Download,
  File,
  FileText,
  FolderOpen,
  LayoutGrid,
  RefreshCw,
  X,
} from '@/components/icons'
import { Modal } from '@/components/modals/Modal'
import { MarkdownLite } from '@/components/chat/MarkdownLite'
import { useChatStore } from '@/store/chat'
import { useUIStore } from '@/store/ui'
import type { Conversation, FileResult } from '@/types'
import { categoryForFileName, FileBadge } from './FileBadge'
import { ControlTooltip } from './ControlTooltip'

interface SandboxFile {
  name: string
  path: string
  size: number
  modifiedAt: number
  content?: string
  source?: 'disk' | 'task'
}

type FileCategory = 'all' | 'image' | 'code' | 'document' | 'data' | 'other'

interface FileCategoryConfig {
  id: FileCategory
  label: string
}

const CATEGORY_ORDER: Array<Exclude<FileCategory, 'all'>> = ['document', 'image', 'code', 'data', 'other']
const CATEGORY_CONFIGS: FileCategoryConfig[] = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Documents' },
  { id: 'image', label: 'Images' },
  { id: 'code', label: 'Code files' },
  { id: 'data', label: 'Data' },
  { id: 'other', label: 'Other' },
]

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'])
const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'rtf'])
const CODE_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'sh', 'sql'])
const DATA_EXTENSIONS = new Set(['json', 'csv', 'xml', 'yaml', 'yml', 'xlsx', 'xls'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ...DATA_EXTENSIONS,
  'md',
  'markdown',
  'txt',
  'rtf',
])
const EMBED_PREVIEW_EXTENSIONS = new Set(['pdf'])
const EMPTY_FILE_PREVIEW_LABEL = 'Empty file'
const FILE_OPEN_ERROR_LABEL = 'Could not open this file.'

function hasInlineFileContent(content: unknown): content is string {
  return typeof content === 'string' && content.length > 0
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDateGroup(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const fileDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  if (fileDay === today) return 'Today'
  if (fileDay === today - 86_400_000) return 'Yesterday'
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatModifiedLabel(ms: number): string {
  const date = new Date(ms)
  const now = Date.now()
  const diff = Math.max(0, now - date.getTime())
  if (diff < 60_000) return 'Last modified: just now'
  if (diff < 60 * 60_000) return `Last modified: ${Math.max(1, Math.floor(diff / 60_000))} minutes ago`
  if (diff < 24 * 60 * 60_000) return `Last modified: ${Math.max(1, Math.floor(diff / (60 * 60_000)))} hours ago`
  return `Last modified: ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

function extensionFor(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

function categoryForName(name: string): Exclude<FileCategory, 'all'> {
  return categoryForFileName(name)
}

function categoryConfig(category: FileCategory): FileCategoryConfig {
  return CATEGORY_CONFIGS.find((item) => item.id === category) || CATEGORY_CONFIGS[0]
}

function taskFileUrl(conversationId: string, path: string, options: { download?: boolean } = {}): string {
  const normalized = normalizeTaskFilePath(path)
  const params = new URLSearchParams({
    conversationId,
    file: normalized,
  })
  params.set(options.download ? 'download' : 'raw', '1')
  return `/api/files?${params.toString()}`
}

function imagePreviewSource(conversationId: string, file: SandboxFile | null): string | null {
  if (!file) return null
  if (typeof file.content === 'string' && file.content.startsWith('data:image/')) return file.content
  return taskFileUrl(conversationId, file.path)
}

function previewKind(name: string): 'image' | 'embed' | 'markdown' | 'text' | 'unsupported' {
  const ext = extensionFor(name)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (EMBED_PREVIEW_EXTENSIONS.has(ext)) return 'embed'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return 'text'
  return 'unsupported'
}

function nameFromPath(path: string): string {
  return path.split('/').pop() || path
}

function normalizeTaskFilePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/')
}

function isUserVisibleTaskFile(path: string): boolean {
  const normalized = normalizeTaskFilePath(path)
  if (!normalized) return false
  if (
    normalized.startsWith('_browser_screenshots/') ||
    normalized.startsWith('_browser_state/') ||
    normalized.startsWith('_internal/') ||
    normalized.startsWith('.agent/') ||
    normalized.startsWith('.next/') ||
    normalized.startsWith('node_modules/') ||
    normalized.startsWith('__pycache__/')
  ) {
    return false
  }

  return nameFromPath(normalized) !== '.DS_Store'
}

function visibleTaskFiles(conversation: Conversation | undefined): {
  files: SandboxFile[]
  deletedPaths: Set<string>
} {
  const byPath = new Map<string, SandboxFile>()
  const deletedPaths = new Set<string>()

  const upsertFile = (
    path: string,
    timestamp: number,
    options: { size?: number; content?: string; action?: FileResult['action'] } = {},
  ) => {
    if (!path) return
    if (!isUserVisibleTaskFile(path)) return

    const normalizedPath = normalizeTaskFilePath(path)

    if (options.action === 'deleted') {
      deletedPaths.add(normalizedPath)
      byPath.delete(normalizedPath)
      return
    }

    const existing = byPath.get(normalizedPath)
    const content = options.content ?? existing?.content
    byPath.set(normalizedPath, {
      name: nameFromPath(normalizedPath),
      path: normalizedPath,
      size: options.size ?? content?.length ?? existing?.size ?? 0,
      modifiedAt: timestamp,
      content,
      source: 'task',
    })
    deletedPaths.delete(normalizedPath)
  }

  for (const message of conversation?.messages || []) {
    for (const group of message.taskGroups || []) {
      for (const subtask of group.subtasks || []) {
        const result = subtask.result as FileResult | undefined
        if (result?.action === 'listed') {
          for (const listedPath of result.files || []) {
            if (!deletedPaths.has(listedPath)) upsertFile(listedPath, subtask.startedAt, { size: 0 })
          }
          continue
        }

        const path = result?.path || subtask.filePath
        if (!path) continue

        if (
          result?.action === 'deleted' ||
          subtask.type === 'delete_file'
        ) {
          upsertFile(path, subtask.startedAt, { action: 'deleted' })
          continue
        }

        if (
          ['create_file', 'read_file', 'edit_file', 'append_file', 'export_pdf'].includes(subtask.type)
        ) {
          upsertFile(path, subtask.startedAt, {
            size: result?.size,
            content: typeof result?.content === 'string' ? result.content : undefined,
            action: result?.action,
          })
        }
      }
    }

    for (const artifact of message.artifacts || []) {
      if (artifact.purpose === 'internal' || !artifact.filePath) continue

      const content = artifact.content || artifact.imageDataUrl || artifact.imageUrl || undefined
      upsertFile(artifact.filePath, artifact.createdAt || message.timestamp, {
        size: content?.length,
        content,
      })
    }

    for (const item of message.computerPanelData || []) {
      if (item.type !== 'file') continue

      const result = item.data as FileResult
      if (!result?.path) continue

      if (result.action === 'deleted') {
        upsertFile(result.path, item.timestamp || message.timestamp, { action: 'deleted' })
        continue
      }

      if (result.action === 'listed') {
        for (const listedPath of result.files || []) {
          if (!isUserVisibleTaskFile(listedPath)) continue
          const normalizedPath = normalizeTaskFilePath(listedPath)
          if (deletedPaths.has(normalizedPath)) continue
          if (!byPath.has(normalizedPath)) {
            byPath.set(normalizedPath, {
              name: nameFromPath(normalizedPath),
              path: normalizedPath,
              size: 0,
              modifiedAt: item.timestamp || message.timestamp,
              source: 'task',
            })
          }
        }
        continue
      }

      if (!['created', 'read', 'edited', 'appended', 'exported'].includes(result.action)) continue

      const existing = byPath.get(result.path)
      const content = typeof result.content === 'string' ? result.content : existing?.content
      upsertFile(result.path, item.timestamp || message.timestamp, {
        size: result.size ?? content?.length ?? existing?.size ?? 0,
        content,
        action: result.action,
      })
    }
  }

  return {
    files: [...byPath.values()].sort((a, b) => b.modifiedAt - a.modifiedAt),
    deletedPaths,
  }
}

interface ProjectFilesProps {
  conversationId: string
}

export function ProjectFiles({ conversationId }: ProjectFilesProps) {
  const conversation = useChatStore((state) =>
    state.conversations.find((item) => item.id === conversationId)
  )
  const openRequest = useUIStore((state) => state.projectFilesOpenRequest)
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<SandboxFile[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<FileCategory>('all')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const handledOpenRequestIdRef = useRef<number | null>(null)

  const fetchFiles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/files?conversationId=${conversationId}`)
      const data = await res.json()
      setFiles(data.files || [])
    } catch {
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    if (open) fetchFiles()
  }, [open, fetchFiles])

  const liveTaskFiles = useMemo(() => visibleTaskFiles(conversation), [conversation])

  const displayedFiles = useMemo(() => {
    const byPath = new Map<string, SandboxFile>()

    for (const file of liveTaskFiles.files) {
      if (!liveTaskFiles.deletedPaths.has(file.path)) byPath.set(file.path, file)
    }

    for (const file of files) {
      if (!isUserVisibleTaskFile(file.path)) continue

      const normalizedPath = normalizeTaskFilePath(file.path)
      if (liveTaskFiles.deletedPaths.has(normalizedPath)) continue

      const liveFile = byPath.get(normalizedPath)
      byPath.set(normalizedPath, {
        ...file,
        name: file.name || nameFromPath(normalizedPath),
        path: normalizedPath,
        content: hasInlineFileContent(liveFile?.content) ? liveFile.content : undefined,
        source: 'disk',
      })
    }

    return [...byPath.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
  }, [files, liveTaskFiles])

  const viewFile = useCallback(async (path: string) => {
    setSelectedFile(path)
    const liveFile = displayedFiles.find((file) => file.path === path)
    const kind = previewKind(liveFile?.name || path)
    if (kind === 'image' || kind === 'embed' || kind === 'unsupported') {
      setFileContent(null)
      setLoadingContent(false)
      return
    }

    const inlineContent = hasInlineFileContent(liveFile?.content) ? liveFile.content : null
    if (inlineContent !== null) {
      setFileContent(inlineContent)
      setLoadingContent(false)
    } else {
      setFileContent(null)
      setLoadingContent(true)
    }
    try {
      const res = await fetch(`/api/files?conversationId=${conversationId}&file=${encodeURIComponent(path)}`)
      if (!res.ok) throw new Error('Unable to read file')
      const data = await res.json()
      setFileContent(typeof data.content === 'string' ? data.content : '')
    } catch {
      if (inlineContent === null) {
        setFileContent(FILE_OPEN_ERROR_LABEL)
      }
    } finally {
      setLoadingContent(false)
    }
  }, [conversationId, displayedFiles])

  useEffect(() => {
    if (!openRequest || openRequest.conversationId !== conversationId) return
    if (handledOpenRequestIdRef.current === openRequest.requestId) return
    handledOpenRequestIdRef.current = openRequest.requestId
    setOpen(true)
    setSelectedCategory('all')
    if (openRequest.filePath) {
      void viewFile(normalizeTaskFilePath(openRequest.filePath))
    }
  }, [conversationId, openRequest, viewFile])

  const downloadFile = (file: SandboxFile, content?: string | null) => {
    const isImage = categoryForName(file.name || file.path) === 'image'
    const source = isImage ? imagePreviewSource(conversationId, file) : null
    const hasTextContent = hasInlineFileContent(content) && content !== FILE_OPEN_ERROR_LABEL
    const url = source && source.startsWith('data:')
      ? source
      : hasTextContent
        ? URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
        : taskFileUrl(conversationId, file.path, { download: true })
    const a = document.createElement('a')
    a.href = url
    a.download = file.name || nameFromPath(file.path) || 'file'
    a.click()
    if (hasTextContent) URL.revokeObjectURL(url)
  }

  const closeProjectFiles = () => {
    setOpen(false)
    setSelectedFile(null)
    setFileContent(null)
    setLoadingContent(false)
  }

  const groupedFiles = useMemo(() => {
    const groups = new Map<Exclude<FileCategory, 'all'>, SandboxFile[]>()
    for (const category of CATEGORY_ORDER) groups.set(category, [])
    for (const file of displayedFiles) {
      groups.get(categoryForName(file.name || file.path))?.push(file)
    }
    return groups
  }, [displayedFiles])

  const categoryCounts = useMemo(() => {
    const counts = new Map<FileCategory, number>()
    counts.set('all', displayedFiles.length)
    for (const category of CATEGORY_ORDER) {
      counts.set(category, groupedFiles.get(category)?.length || 0)
    }
    return counts
  }, [displayedFiles.length, groupedFiles])

  const filteredFiles = useMemo(() => {
    if (selectedCategory === 'all') return displayedFiles
    return displayedFiles.filter((file) => categoryForName(file.name || file.path) === selectedCategory)
  }, [displayedFiles, selectedCategory])

  const dateGroups = useMemo(() => {
    const groups: Array<{ label: string; files: SandboxFile[] }> = []
    const byLabel = new Map<string, SandboxFile[]>()
    for (const file of filteredFiles) {
      const label = formatDateGroup(file.modifiedAt)
      if (!byLabel.has(label)) {
        byLabel.set(label, [])
        groups.push({ label, files: byLabel.get(label)! })
      }
      byLabel.get(label)!.push(file)
    }
    return groups
  }, [filteredFiles])

  const selectedFileInfo = selectedFile
    ? displayedFiles.find((file) => file.path === selectedFile) || null
    : null
  const selectedPreviewKind = previewKind(selectedFileInfo?.name || selectedFile || '')
  const selectedImageSource = selectedPreviewKind === 'image' ? imagePreviewSource(conversationId, selectedFileInfo) : null
  const selectedFileUrl = selectedFileInfo ? taskFileUrl(conversationId, selectedFileInfo.path) : null

  return (
    <div className="group/tooltip relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={displayedFiles.length > 0 ? `Open task files (${displayedFiles.length})` : 'Open task files'}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`subtle-icon-button flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150 active:scale-[0.96] ${
          open ? 'is-active' : ''
        }`}
      >
        <FileText size={16} strokeWidth={2.2} />
      </button>
      {!open && <ControlTooltip label="Task files" />}

      <Modal
        open={open}
        onClose={closeProjectFiles}
        panelClassName={selectedFileInfo ? 'max-w-[1160px] h-[720px] max-h-[90vh]' : 'max-w-[760px] h-[720px] max-h-[88vh]'}
      >
        {selectedFileInfo ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-16 flex-shrink-0 items-center gap-3 border-b border-border-secondary px-6 py-3">
              <FileBadge name={selectedFileInfo.name} large />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold tracking-[0] text-text-primary">{selectedFileInfo.name}</div>
                <div className="mt-0.5 truncate text-[12px] font-medium text-text-tertiary">
                  {formatModifiedLabel(selectedFileInfo.modifiedAt)}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => downloadFile(selectedFileInfo, selectedFile === selectedFileInfo.path ? fileContent : null)}
                  aria-label={`Download ${selectedFileInfo.name}`}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
                >
                  <Download size={15} strokeWidth={2.35} />
                </button>
                <div className="mx-1 h-5 w-px bg-border-secondary" />
                <button
                  type="button"
                  onClick={() => { setSelectedFile(null); setFileContent(null) }}
                  aria-label="Back to file list"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
                >
                  <LayoutGrid size={15} strokeWidth={2.35} />
                </button>
                <button
                  type="button"
                  onClick={closeProjectFiles}
                  aria-label="Close project files"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
                >
                  <X size={15} strokeWidth={2.35} />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary">
              {selectedPreviewKind === 'image' && selectedImageSource ? (
                <div className="flex min-h-full items-center justify-center p-8">
                  <img
                    src={selectedImageSource}
                    alt={selectedFileInfo.name}
                    className="max-h-full max-w-full rounded-xl object-contain"
                  />
                </div>
              ) : selectedPreviewKind === 'embed' && selectedFileUrl ? (
                <iframe
                  src={selectedFileUrl}
                  title={selectedFileInfo.name}
                  className="h-full min-h-[620px] w-full border-0 bg-bg-primary"
                />
              ) : selectedPreviewKind === 'markdown' ? (
                <div className="mx-auto max-w-[760px] px-10 py-9">
                  {loadingContent ? (
                    <div className="flex items-center gap-2 text-[13px] text-text-muted">
                      <RefreshCw size={13} className="animate-spin" strokeWidth={2.25} />
                      Loading file
                    </div>
                  ) : (
                    <div className="markdown-content chat-reading-text text-text-primary">
                      {fileContent === '' ? (
                        <p className="text-[13px] font-medium text-text-tertiary">{EMPTY_FILE_PREVIEW_LABEL}</p>
                      ) : (
                        <MarkdownLite>{fileContent || ''}</MarkdownLite>
                      )}
                    </div>
                  )}
                </div>
              ) : selectedPreviewKind === 'text' ? (
                <pre className="mx-auto min-h-full max-w-[900px] px-8 py-7 text-[12px] leading-relaxed text-text-secondary font-mono whitespace-pre-wrap break-words">
                  {loadingContent ? 'Loading...' : fileContent === '' ? EMPTY_FILE_PREVIEW_LABEL : fileContent ?? ''}
                </pre>
              ) : (
                <div className="flex h-full min-h-[520px] flex-col items-center justify-center px-8 text-center">
                  <FileBadge name={selectedFileInfo.name} large />
                  <p className="mt-4 text-[14px] font-semibold text-text-primary tracking-[0]">Preview unavailable</p>
                  <p className="mt-1 max-w-[300px] text-[12px] leading-relaxed text-text-tertiary">
                    This file type can still be downloaded from the toolbar.
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col px-6 py-5 sm:px-7 sm:py-6">
            <div className="flex flex-shrink-0 items-center justify-between gap-3">
              <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-text-primary">All files in this task</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={fetchFiles}
                  aria-label="Refresh project files"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
                >
                  <RefreshCw size={15} className={loading ? 'animate-spin' : ''} strokeWidth={2.35} />
                </button>
                <button
                  type="button"
                  onClick={closeProjectFiles}
                  aria-label="Close project files"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
                >
                  <X size={15} strokeWidth={2.35} />
                </button>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="File categories">
              {CATEGORY_CONFIGS.map((category) => {
                const active = selectedCategory === category.id
                const count = categoryCounts.get(category.id) || 0
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setSelectedCategory(category.id)}
                    role="tab"
                    aria-selected={active}
                    aria-controls="task-files-list"
                    aria-label={`${category.label}, ${count} ${count === 1 ? 'file' : 'files'}`}
                    className={`h-9 rounded-full border border-transparent px-3.5 text-[12.5px] font-semibold transition-colors duration-150 ${
                      active
                        ? 'bg-bg-tertiary text-text-primary'
                        : 'bg-transparent text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
                    }`}
                  >
                    {category.label}
                  </button>
                )
              })}
            </div>

            <div
              id="task-files-list"
              role="tabpanel"
              className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1"
            >
              {loading && displayedFiles.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <RefreshCw size={16} className="animate-spin text-text-muted" strokeWidth={2.2} />
                </div>
              ) : displayedFiles.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border-primary bg-bg-secondary">
                    <File size={18} className="text-text-tertiary" strokeWidth={1.75} />
                  </div>
                  <p className="text-[14px] font-semibold text-text-primary tracking-[0]">No files yet</p>
                  <p className="mt-1 max-w-[240px] text-[12px] leading-relaxed text-text-tertiary">
                    Files created by the agent appear here.
                  </p>
                </div>
              ) : filteredFiles.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border-primary bg-bg-secondary">
                    <FolderOpen size={18} className="text-text-tertiary" strokeWidth={1.75} />
                  </div>
                  <p className="text-[14px] font-semibold text-text-primary tracking-[0]">No {categoryConfig(selectedCategory).label.toLowerCase()}</p>
                  <p className="mt-1 max-w-[240px] text-[12px] leading-relaxed text-text-tertiary">
                    Try another file type.
                  </p>
                </div>
              ) : (
                <div className="space-y-6 pb-2">
                  {dateGroups.map((group) => (
                    <section key={group.label}>
                      <div className="mb-2.5 text-[12px] font-medium text-text-tertiary">{group.label}</div>
                      <div className="space-y-0.5">
                        {group.files.map((file) => (
                          <div
                            key={file.path}
                            className="group flex items-center gap-3 rounded-lg px-1.5 py-2.5 transition-colors duration-150 hover:bg-bg-secondary"
                          >
                            <button
                              type="button"
                              onClick={() => viewFile(file.path)}
                              aria-label={`Open ${file.path}, ${formatSize(file.size)}`}
                              className="flex min-w-0 flex-1 items-center gap-3 text-left"
                            >
                              <FileBadge name={file.name} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[14px] font-semibold tracking-[0] text-text-primary">{file.name}</span>
                                <span className="mt-0.5 block truncate text-[12px] font-medium text-text-tertiary">
                                  {formatDateGroup(file.modifiedAt)}, {formatTime(file.modifiedAt)}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => downloadFile(file, file.content)}
                              aria-label={`Download ${file.name}`}
                              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-muted opacity-100 transition-all duration-150 hover:bg-bg-primary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                            >
                              <Download size={14} strokeWidth={2.35} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
