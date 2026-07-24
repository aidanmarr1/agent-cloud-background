'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent, ChangeEvent } from 'react'
import { ArrowUp, Square, Plus, Paperclip, BookOpen, FolderUp, Loader2, ChevronRight, Search, Settings, X } from '@/components/icons'
import { useUIStore } from '@/store/ui'
import { useSettingsStore } from '@/store/settings'
import type { FileAttachment, SavedSkill, SlashCommand } from '@/types'
import { filterCommands } from '@/lib/slashCommands'
import { createSkillAttachment, FILE_ACCEPT, processFilesForAttachments, SKILL_ATTACHMENT_TYPE } from '@/lib/fileHandling'
import { uploadAttachmentsToServer } from '@/lib/attachmentUpload'
import { SlashCommandMenu } from './SlashCommandMenu'
import { AttachmentPreviewRow, getAttachmentKey } from './AttachmentPreview'
import { MAX_TASK_INPUT_CHARS, clampTaskInput, taskInputLimitMessage } from '@/lib/inputLimits'

interface ChatInputProps {
  onSubmit: (message: string, attachments?: FileAttachment[]) => void | Promise<void>
  onStop?: () => void
  onSlashAction?: (action: string) => void
  placeholder?: string
  rainbow?: boolean
  conversationId?: string
  initialValue?: string
  variant?: 'hero' | 'thread'
}

interface SlashRange {
  start: number
  end: number
  query: string
}

function formatFileBatch(files: File[]): string {
  if (files.length === 0) return 'Preparing files for the agent'
  const firstPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || files[0].name
  if (files.some((file) => ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).includes('/'))) {
    const folderName = firstPath.split('/')[0] || 'Folder'
    return `${folderName} folder (${files.length} files)`
  }
  if (files.length === 1) return files[0].name
  return `${files.length} files`
}

function getActiveSlashRange(text: string, cursor: number): SlashRange | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const beforeCursor = text.slice(0, safeCursor)
  const tokenStart = Math.max(
    beforeCursor.lastIndexOf(' '),
    beforeCursor.lastIndexOf('\n'),
    beforeCursor.lastIndexOf('\t')
  ) + 1
  const afterCursor = text.slice(safeCursor)
  const nextWhitespace = afterCursor.search(/\s/)
  const tokenEnd = nextWhitespace === -1 ? text.length : safeCursor + nextWhitespace
  const token = text.slice(tokenStart, tokenEnd)

  // Skill slash tokens are word-like: "/frontend-standard".
  // This avoids opening the menu for URLs and paths such as https://example.com/a/b.
  if (!token.startsWith('/') || token.length > 80 || token.includes('//')) return null
  return { start: tokenStart, end: tokenEnd, query: token }
}

export function ChatInput({
  onSubmit,
  onStop,
  placeholder = 'Assign a task or ask anything',
  rainbow = false,
  conversationId,
  initialValue,
  variant = 'hero',
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [sendButtonPop, setSendButtonPop] = useState(false)
  const [submitPending, setSubmitPending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; name: string }>>([])
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashFiltered, setSlashFiltered] = useState<SlashCommand[]>([])
  const [slashRange, setSlashRange] = useState<SlashRange | null>(null)
  const [cursorPosition, setCursorPosition] = useState(0)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const dragDepthRef = useRef(0)
  const prevHasValueRef = useRef(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingBatchRef = useRef(0)
  const isStreaming = useUIStore((s) => s.isStreaming)
  const skills = useSettingsStore((s) => s.skillLibrary)
  const normalizedSkillQuery = skillQuery.trim().toLowerCase()
  const visibleSkills = normalizedSkillQuery
    ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(normalizedSkillQuery))
    : skills
  const isProcessingFiles = pendingFiles.length > 0
  const hasText = value.trim().length > 0
  const hasValue = value.trim().length > 0 || attachments.length > 0
  const inputBusy = submitPending || isProcessingFiles
  const optimisticTaskStarting = submitPending && !isStreaming && !isProcessingFiles
  const canSendLiveInstruction = isStreaming && hasText && attachments.length === 0 && !inputBusy
  const liveInstructionBlockedByAttachments = isStreaming && attachments.length > 0
  const showStopButton = (isStreaming || optimisticTaskStarting) && !!onStop
  const showSendButton = !(isStreaming || optimisticTaskStarting) || canSendLiveInstruction
  const compact = variant === 'thread'
  const atInputLimit = value.length >= MAX_TASK_INPUT_CHARS

  const setClampedValue = useCallback((next: string) => {
    const clamped = clampTaskInput(next)
    setValue(clamped)
    if (next.length > MAX_TASK_INPUT_CHARS) {
      useUIStore.getState().addToast(taskInputLimitMessage(), 'error')
    }
    return clamped
  }, [])

  const setTextareaCursorAt = useCallback((position: number) => {
    if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current)
    cursorTimerRef.current = setTimeout(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.selectionStart = ta.selectionEnd = Math.max(0, Math.min(position, ta.value.length))
      setCursorPosition(ta.selectionStart)
      cursorTimerRef.current = null
    }, 0)
  }, [])

  const replaceSlashRange = useCallback((insertText: string) => {
    const ta = textareaRef.current
    const activeRange = slashRange ?? getActiveSlashRange(value, ta?.selectionStart ?? value.length)
    if (!activeRange) {
      const next = value ? `${value}${value.endsWith(' ') ? '' : ' '}${insertText}` : insertText
      const clamped = setClampedValue(next)
      setSlashMenuOpen(false)
      setSlashRange(null)
      setTextareaCursorAt(clamped.length)
      return
    }

    const before = value.slice(0, activeRange.start)
    let after = value.slice(activeRange.end)
    if (insertText.endsWith(' ') && after.startsWith(' ')) after = after.replace(/^\s+/, '')
    const leading = before && !/\s$/.test(before) ? ' ' : ''
    const trailing = after && !/^\s/.test(after) && !insertText.endsWith(' ') ? ' ' : ''
    const next = `${before}${leading}${insertText}${trailing}${after}`
    const clamped = setClampedValue(next)
    const nextCursor = Math.min(before.length + leading.length + insertText.length + trailing.length, clamped.length)

    setSlashMenuOpen(false)
    setSlashRange(null)
    setTextareaCursorAt(nextCursor)
  }, [setClampedValue, setTextareaCursorAt, slashRange, value])

  useEffect(() => {
    if (isStreaming) setSubmitPending(false)
  }, [isStreaming])

  // Pre-fill from initialValue prop (e.g. quick actions)
  useEffect(() => {
    if (initialValue) {
      const clamped = setClampedValue(initialValue)
      setTextareaCursorAt(clamped.length)
    }
  }, [initialValue, setClampedValue, setTextareaCursorAt])

  useEffect(() => () => {
    if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current)
  }, [])

  // Draft auto-save: restore on mount
  useEffect(() => {
    if (!conversationId) return
    const draft = localStorage.getItem(`agent-draft-${conversationId}`)
    if (draft) setClampedValue(draft)
  }, [conversationId, setClampedValue])

  // Draft auto-save: debounced save
  useEffect(() => {
    if (!conversationId) return
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      if (value) {
        localStorage.setItem(`agent-draft-${conversationId}`, value)
      } else {
        localStorage.removeItem(`agent-draft-${conversationId}`)
      }
    }, 500)
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current) }
  }, [value, conversationId])

  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }, [value])

  useEffect(() => {
    if (!attachMenuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && attachMenuRef.current?.contains(target)) return
      setAttachMenuOpen(false)
      setSkillPickerOpen(false)
    }

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAttachMenuOpen(false)
        setSkillPickerOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [attachMenuOpen])

  const updateCursorPosition = useCallback(() => {
    const ta = textareaRef.current
    setCursorPosition(ta?.selectionStart ?? value.length)
  }, [value.length])

  // Slash command detection at the current cursor position, not only at the beginning.
  useEffect(() => {
    const activeRange = getActiveSlashRange(value, cursorPosition)
    setSlashRange(activeRange)

    if (activeRange) {
      const filtered = filterCommands(activeRange.query, skills)
      setSlashFiltered(filtered)
      setSlashMenuOpen(filtered.length > 0)
      setSlashSelectedIndex(0)
    } else {
      setSlashMenuOpen(false)
    }
  }, [cursorPosition, value, skills])

  const attachSavedSkill = useCallback((skill: SavedSkill, replaceActiveSlash = false) => {
    const skillAttachment = createSkillAttachment(skill)
    setAttachments((prev) => [
      ...prev.filter((att) => !(att.type === SKILL_ATTACHMENT_TYPE && att.name === skillAttachment.name)),
      skillAttachment,
    ])

    const instruction = `Use the "${skill.name}" skill. `
    if (replaceActiveSlash) {
      replaceSlashRange(instruction)
    } else {
      const separator = value && !value.endsWith(' ') ? ' ' : ''
      const clamped = setClampedValue(`${value}${separator}${instruction}`)
      setTextareaCursorAt(clamped.length)
    }

    setAttachMenuOpen(false)
    setSkillPickerOpen(false)
    setSkillQuery('')
    useUIStore.getState().addToast(`Attached skill: ${skill.name}`, 'success')
  }, [replaceSlashRange, setClampedValue, setTextareaCursorAt, value])

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setSlashMenuOpen(false)
    if (cmd.handler === 'skill' && cmd.skillId) {
      const skill = useSettingsStore.getState().skillLibrary.find((item) => item.id === cmd.skillId)
      if (!skill) {
        useUIStore.getState().addToast('That saved skill is no longer available.', 'error')
        return
      }
      attachSavedSkill(skill, true)
    }
  }, [attachSavedSkill])

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim()
    if ((!trimmed && attachments.length === 0) || inputBusy || liveInstructionBlockedByAttachments) return
    if (value.length > MAX_TASK_INPUT_CHARS) {
      setClampedValue(value)
      return
    }

    const submittedValue = value
    const submittedAttachments = attachments
    let restorableAttachments = submittedAttachments
    const message = trimmed || 'Analyze the attached file(s).'
    setSubmitPending(true)

    void (async () => {
      let persistedAttachments = submittedAttachments
      if (persistedAttachments.some((attachment) => !attachment.id || !attachment.persisted)) {
        const uploadResult = await uploadAttachmentsToServer(persistedAttachments, conversationId)
        persistedAttachments = uploadResult.attachments
        restorableAttachments = persistedAttachments
        if (uploadResult.errors.length > 0) {
          throw new Error(uploadResult.errors[0])
        }
        if (persistedAttachments.some((attachment) => !attachment.id || !attachment.persisted)) {
          throw new Error('One or more attachments did not finish uploading. Remove them and try again.')
        }
      }

      setValue('')
      setAttachments([])
      if (conversationId) localStorage.removeItem(`agent-draft-${conversationId}`)
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      await onSubmit(message, persistedAttachments.length > 0 ? persistedAttachments : undefined)
    })()
      .catch((error) => {
        const message = error instanceof Error && error.message
          ? error.message
          : 'Could not start the task.'
        useUIStore.getState().addToast(message, 'error')
        setValue(submittedValue)
        setAttachments(restorableAttachments)
        if (conversationId && submittedValue) localStorage.setItem(`agent-draft-${conversationId}`, submittedValue)
      })
      .finally(() => {
        if (!useUIStore.getState().isStreaming) setSubmitPending(false)
      })
  }, [value, attachments, inputBusy, liveInstructionBlockedByAttachments, onSubmit, conversationId, setClampedValue])

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileList = Array.from(files)
    if (fileList.length === 0) return

    const batchId = ++pendingBatchRef.current
    const containsFolderPaths = fileList.some((file) => {
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      return path.includes('/')
    })
    const pendingNames = containsFolderPaths
      ? [formatFileBatch(fileList)]
      : fileList.map((file) => file.name)
    const nextPending = pendingNames.map((name, index) => ({ id: `${batchId}-${index}`, name }))
    const nextPendingIds = new Set(nextPending.map((item) => item.id))
    setPendingFiles((current) => [...current, ...nextPending])
    try {
      const result = await processFilesForAttachments(fileList)

      for (const error of result.errors) {
        useUIStore.getState().addToast(error, 'error')
      }
      for (const warning of result.warnings.slice(0, 2)) {
        useUIStore.getState().addToast(warning, 'info')
      }

      let readyAttachments = result.attachments
      if (readyAttachments.length > 0) {
        const uploadResult = await uploadAttachmentsToServer(readyAttachments, conversationId)
        readyAttachments = uploadResult.attachments
        for (const error of uploadResult.errors) {
          useUIStore.getState().addToast(error, 'error')
        }
      }

      if (readyAttachments.length > 0) {
        setAttachments((prev) => {
          const keys = new Set(prev.map(getAttachmentKey))
          const unique: FileAttachment[] = []
          let duplicates = 0

          for (const attachment of readyAttachments) {
            const key = getAttachmentKey(attachment)
            if (keys.has(key)) {
              duplicates += 1
              continue
            }
            keys.add(key)
            unique.push(attachment)
          }

          if (duplicates > 0) {
            queueMicrotask(() => {
              useUIStore.getState().addToast(
                duplicates === 1 ? 'Skipped duplicate attachment.' : `Skipped ${duplicates} duplicate attachments.`,
                'info'
              )
            })
          }

          return unique.length > 0 ? [...prev, ...unique] : prev
        })
      }
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : 'Could not process the selected attachment.'
      useUIStore.getState().addToast(message, 'error')
    } finally {
      setPendingFiles((current) => current.filter((item) => !nextPendingIds.has(item.id)))
    }
  }, [conversationId])

  const handleFileSelect = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files)
      e.target.value = '' // Reset so same file can be re-selected
    }
  }, [processFiles])

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  // Drag & drop
  const [dragOver, setDragOver] = useState(false)
  const [dragItemCount, setDragItemCount] = useState(0)
  const updateDragItemCount = useCallback((transfer: DataTransfer) => {
    const itemCount = Array.from(transfer.items || []).filter((item) => item.kind === 'file').length
    setDragItemCount(itemCount || transfer.files?.length || 0)
  }, [])
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current += 1
    updateDragItemCount(e.dataTransfer)
    setDragOver(true)
  }, [updateDragItemCount])
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    updateDragItemCount(e.dataTransfer)
    setDragOver(true)
  }, [updateDragItemCount])
  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragOver(false)
      setDragItemCount(0)
    }
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    setDragItemCount(0)
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files)
    }
  }, [processFiles])

  const sendWithEnter = useSettingsStore((s) => s.sendWithEnter)

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash menu keyboard navigation
    if (slashMenuOpen && slashFiltered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % slashFiltered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + slashFiltered.length) % slashFiltered.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSlashSelect(slashFiltered[slashSelectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashMenuOpen(false)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        handleSlashSelect(slashFiltered[slashSelectedIndex])
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (sendWithEnter || e.metaKey || e.ctrlKey) {
        e.preventDefault()
        handleSubmit()
      }
    }
  }

  // Send button pop animation when hasValue transitions to true
  useEffect(() => {
    if (hasValue && !prevHasValueRef.current) {
      setSendButtonPop(true)
      prevHasValueRef.current = true
      const timer = setTimeout(() => setSendButtonPop(false), 300)
      return () => clearTimeout(timer)
    }
    prevHasValueRef.current = hasValue
  }, [hasValue])

  // Paste text only; image uploads are intentionally not supported.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = e.clipboardData?.getData('text')
    if (!pastedText) return

    const ta = textareaRef.current
    const selectionStart = Math.max(0, Math.min(ta?.selectionStart ?? cursorPosition, value.length))
    const selectionEnd = Math.max(selectionStart, Math.min(ta?.selectionEnd ?? selectionStart, value.length))
    const next = `${value.slice(0, selectionStart)}${pastedText}${value.slice(selectionEnd)}`
    if (next.length > MAX_TASK_INPUT_CHARS) {
      e.preventDefault()
      const replacedLength = selectionEnd - selectionStart
      const available = Math.max(0, MAX_TASK_INPUT_CHARS - (value.length - replacedLength))
      const inserted = pastedText.slice(0, available)
      const clamped = `${value.slice(0, selectionStart)}${inserted}${value.slice(selectionEnd)}`
      setValue(clamped)
      const nextCursor = selectionStart + inserted.length
      requestAnimationFrame(() => {
        const input = textareaRef.current
        if (!input) return
        input.selectionStart = input.selectionEnd = nextCursor
        setCursorPosition(input.selectionStart)
      })
      useUIStore.getState().addToast(taskInputLimitMessage(), 'error')
    }
  }, [cursorPosition, value])

  const attachmentItemCount = attachments.length + pendingFiles.length
  const contextualPlaceholder = attachmentItemCount > 0
    ? `Tell Agent what to do with the ${attachmentItemCount === 1 ? 'file' : 'files'}`
    : placeholder

  return (
    <div
      className={`task-input-surface relative w-full border bg-bg-secondary transition-all duration-200 ${
        compact ? 'max-w-[860px]' : 'max-w-[780px]'
      } ${
        compact ? 'min-h-[96px] rounded-[20px]' : 'min-h-[116px] rounded-[24px]'
      } ${
        rainbow
          ? `border-transparent${dragOver ? ' scale-[1.01]' : ''}`
          : dragOver ? 'border-border-tertiary bg-bg-tertiary scale-[1.005]' : focused ? 'border-border-tertiary' : 'border-border-primary hover:border-border-tertiary'
      }`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl border border-border-primary bg-bg-card">
          <div className="flex items-center gap-3 rounded-2xl border border-border-primary bg-bg-secondary px-4 py-3" style={{ boxShadow: 'var(--shadow-lg)' }}>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border-primary bg-bg-primary text-accent-blue">
              <Paperclip size={16} strokeWidth={2.35} />
            </div>
            <div>
              <div className="text-[13px] font-semibold text-text-primary">
                Drop to attach
              </div>
              <div className="text-[11.5px] text-text-muted">
                {dragItemCount === 1 ? '1 item will be added as context' : `${dragItemCount || 'Files'} will be added as context`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept={FILE_ACCEPT}
        onChange={handleFileSelect}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={handleFileSelect}
      />

      {/* Attachment previews */}
      {(attachments.length > 0 || isProcessingFiles) && (
        <div className="px-3 pt-3">
          <div className="scrollbar-none flex gap-2 overflow-x-auto pb-0.5">
            {attachments.length > 1 && (
              <button
                type="button"
                onClick={() => setAttachments([])}
                aria-label="Remove all attached files"
                title="Remove all files"
                className="flex h-[66px] w-11 flex-none items-center justify-center rounded-lg border border-border-primary bg-bg-primary text-text-muted transition-colors hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary"
              >
                <X size={15} strokeWidth={2.25} />
              </button>
            )}
            {attachments.map((att, i) => (
              <AttachmentPreviewRow
                key={`${getAttachmentKey(att)}-${i}`}
                attachment={att}
                onRemove={() => removeAttachment(i)}
              />
            ))}
            {pendingFiles.map((pendingFile) => (
              <div
                key={pendingFile.id}
                className="flex h-[66px] w-[278px] flex-none items-center gap-3 rounded-xl border border-border-primary bg-bg-primary px-3 text-text-secondary animate-scale-in"
                aria-label={`${pendingFile.name}, uploading`}
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-secondary">
                  <Loader2 size={17} className="text-text-muted" style={{ animation: 'spin 1s linear infinite' }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-text-primary">{pendingFile.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-text-muted">Uploading …</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Slash command menu */}
      <div className="relative">
        <SlashCommandMenu
          commands={slashFiltered}
          selectedIndex={slashSelectedIndex}
          onSelect={handleSlashSelect}
          visible={slashMenuOpen}
        />
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          const clamped = setClampedValue(e.target.value)
          setCursorPosition(Math.min(e.target.selectionStart, clamped.length))
        }}
        maxLength={MAX_TASK_INPUT_CHARS}
        onKeyDown={handleKeyDown}
        onKeyUp={updateCursorPosition}
        onClick={updateCursorPosition}
        onSelect={updateCursorPosition}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPaste={handlePaste}
        placeholder={contextualPlaceholder}
        rows={1}
        aria-label={compact ? 'Add a follow-up or give direction' : 'Describe a task for Agent'}
        className={`${compact ? 'min-h-[46px] px-4 pt-3.5 pb-0.5 sm:px-5' : 'min-h-[64px] px-5 pt-5 pb-1 sm:px-5'} w-full resize-none bg-transparent text-text-primary outline-none placeholder:text-text-muted chat-input-text leading-relaxed`}
      />
      <div className={`${compact ? 'h-[46px]' : 'h-[48px]'} flex items-center justify-between px-3 pb-1 sm:px-3.5`}>
        <div className="flex items-center gap-0.5">
          {/* Add attachment menu */}
          <div ref={attachMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setAttachMenuOpen((open) => {
                  if (open) setSkillPickerOpen(false)
                  return !open
                })
              }}
              className={`subtle-icon-button h-9 w-9 rounded-full flex items-center justify-center transition-all duration-150 active:scale-[0.96] ${
                attachMenuOpen ? 'is-active' : ''
              }`}
              title="Add attachment"
              aria-label="Add attachment"
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
            >
              <Plus size={17} strokeWidth={2.35} weight="regular" />
            </button>

            {attachMenuOpen && (
              <div
                role="menu"
                aria-label="Add context"
                className={`fixed left-3 right-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-40 w-auto origin-top-left rounded-xl border border-border-primary menu-surface p-1.5 animate-scale-in sm:absolute sm:left-0 sm:right-auto sm:w-[220px] ${
                  compact ? 'sm:bottom-full sm:top-auto sm:mb-2' : 'sm:bottom-auto sm:top-full sm:mt-2'
                }`}
                style={{ boxShadow: 'var(--shadow-menu)' }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onMouseEnter={() => setSkillPickerOpen(false)}
                  onClick={() => {
                    setAttachMenuOpen(false)
                    setSkillPickerOpen(false)
                    fileInputRef.current?.click()
                  }}
                  className="group flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-100 hover:bg-bg-hover focus-visible:bg-bg-hover"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-text-muted transition-colors group-hover:text-text-primary">
                    <Paperclip size={15} strokeWidth={2.15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary">Add from local files</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onMouseEnter={() => setSkillPickerOpen(false)}
                  onClick={() => {
                    setAttachMenuOpen(false)
                    setSkillPickerOpen(false)
                    folderInputRef.current?.click()
                  }}
                  className="group flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-100 hover:bg-bg-hover focus-visible:bg-bg-hover"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-text-muted transition-colors group-hover:text-text-primary">
                    <FolderUp size={15} strokeWidth={2.15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary">Add a folder</span>
                </button>
                <div className="my-1 h-px bg-border-secondary" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={skills.length === 0}
                  onClick={() => {
                    if (skills.length > 0) setSkillPickerOpen((open) => !open)
                  }}
                  onMouseEnter={() => {
                    if (skills.length > 0) setSkillPickerOpen(true)
                  }}
                  aria-haspopup="dialog"
                  aria-expanded={skillPickerOpen}
                  className={`group flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-100 hover:bg-bg-hover focus-visible:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent ${
                    skillPickerOpen ? 'bg-bg-hover' : ''
                  }`}
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-text-muted transition-colors group-hover:text-text-primary">
                    <BookOpen size={15} strokeWidth={2.15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary">Use saved skill</span>
                  <ChevronRight size={13} className="flex-shrink-0 text-text-muted" strokeWidth={2.1} />
                </button>

                {skillPickerOpen && skills.length > 0 && (
                  <div
                    role="dialog"
                    aria-label="Saved skills"
                    className="mt-1 rounded-lg border border-border-primary bg-bg-elevated p-1.5 sm:absolute sm:left-[calc(100%+8px)] sm:top-0 sm:mt-0 sm:w-[300px]"
                    style={{ boxShadow: 'var(--shadow-menu)' }}
                  >
                    <div className="flex h-9 items-center gap-2 rounded-lg border border-border-primary bg-bg-primary px-2.5 text-text-muted focus-within:border-border-tertiary focus-within:text-text-secondary">
                      <Search size={14} strokeWidth={2.1} />
                      <input
                        value={skillQuery}
                        onChange={(event) => setSkillQuery(event.target.value)}
                        placeholder="Search saved skills"
                        aria-label="Search saved skills"
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                      />
                    </div>
                    <div className="mt-1 max-h-[184px] overflow-y-auto">
                      {visibleSkills.length > 0 ? visibleSkills.map((skill) => (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => attachSavedSkill(skill)}
                          className="group flex min-h-11 w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-bg-hover focus-visible:bg-bg-hover"
                        >
                          <BookOpen size={14} className="mt-0.5 flex-shrink-0 text-text-muted group-hover:text-text-primary" strokeWidth={2.1} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-medium text-text-primary">{skill.name}</span>
                            <span className="mt-0.5 block truncate text-[10.5px] text-text-muted">{skill.description || skill.sourceName}</span>
                          </span>
                        </button>
                      )) : (
                        <p className="px-3 py-5 text-center text-[11.5px] text-text-muted">No matching skills</p>
                      )}
                    </div>
                    <div className="my-1 h-px bg-border-secondary" />
                    <button
                      type="button"
                      onClick={() => {
                        setAttachMenuOpen(false)
                        setSkillPickerOpen(false)
                        useUIStore.getState().setSettingsTab('skills')
                        useUIStore.getState().setSettingsOpen(true)
                      }}
                      className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover focus-visible:bg-bg-hover"
                    >
                      <Settings size={14} className="text-text-muted" strokeWidth={2.1} />
                      Manage skills
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Separator + char count + composing dot */}
          <div className={`flex items-center overflow-hidden transition-all duration-200 ${value.length > 0 ? 'opacity-100 max-w-[132px] ml-1.5' : 'opacity-0 max-w-0'}`}>
            <div className="w-px h-4 bg-border-secondary mr-1.5" />
            <span className={`text-[11px] tabular-nums whitespace-nowrap ${atInputLimit ? 'text-accent-red' : 'text-text-muted'}`}>
              {value.length.toLocaleString()} / {MAX_TASK_INPUT_CHARS.toLocaleString()}
            </span>
            {focused && value.length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-bg-secondary ml-1 flex-shrink-0" style={{ animation: 'pulse-dot 1.4s infinite ease-in-out' }} />
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Keyboard hint */}
          {focused && !value && attachments.length === 0 && (
            <span className="text-[10.5px] text-text-muted hidden md:flex items-center mr-1.5 font-mono tabular-nums">
              {sendWithEnter ? '↵ Send' : '⌘↵ Send'}
            </span>
          )}
          {showStopButton && (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop task"
              className={`${compact ? 'h-9 w-9 rounded-full sm:w-auto sm:rounded-lg sm:px-3 sm:gap-1.5' : 'h-9 w-9 rounded-full'} flex items-center justify-center bg-text-primary hover:opacity-80 active:scale-95 transition-all duration-200`}
              title="Stop generating"
            >
              <Square size={11} className="text-primary-foreground" fill="currentColor" />
              {compact && <span className="hidden text-[12px] font-semibold text-primary-foreground sm:inline">Stop</span>}
            </button>
          )}
          {showSendButton && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasValue || inputBusy || liveInstructionBlockedByAttachments}
              aria-label={canSendLiveInstruction ? 'Send live instruction' : 'Send message'}
              title={canSendLiveInstruction ? 'Send live instruction to current task' : 'Send message'}
              className={`${compact && canSendLiveInstruction ? 'h-9 w-9 rounded-full sm:w-auto sm:rounded-lg sm:px-3 sm:gap-1.5' : 'h-9 w-9 rounded-full'} flex items-center justify-center transition-all duration-200 ${
                hasValue && !inputBusy
                  ? 'bg-text-primary hover:opacity-80 active:scale-90 scale-100'
                  : 'bg-border-primary scale-95 opacity-40'
              } ${sendButtonPop ? 'animate-button-pop' : ''}`}
            >
              {submitPending || isProcessingFiles ? (
                <Loader2 size={15} className="text-text-muted" style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <>
                  {compact && canSendLiveInstruction && (
                    <span className="hidden text-[12px] font-semibold text-primary-foreground sm:inline">Send direction</span>
                  )}
                  <ArrowUp
                    size={17}
                    strokeWidth={2.5}
                    className={hasValue && !inputBusy ? 'text-primary-foreground' : 'text-text-muted'}
                  />
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
