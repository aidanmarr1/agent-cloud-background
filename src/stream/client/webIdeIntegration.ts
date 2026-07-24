import { useUIStore } from '@/store/ui'
import { useChatStore } from '@/store/chat'
import type { FileResult, ComputerPanelItem, Message } from '@/types'

const MAX_FILE_CONTENT_ACCUM = 100_000
const HTML_ENTRY_RE = /(^|\/)index\.html$/i
const NEXT_PAGE_RE = /(^|\/)(?:src\/)?app\/page\.tsx$/i
const NEXT_APP_FILE_RE = /(^|\/)(?:src\/)?app\/(?:page|layout)\.tsx$|(^|\/)(?:src\/)?app\/globals\.css$/i
const NEXT_COMPONENT_FILE_RE = /(^|\/)(?:src\/)?(?:components|app\/components)\/.+\.tsx$/i

function capStr(s: string, max: number): string {
  if (s.length <= max) return s
  return '[truncated]\n' + s.slice(s.length - (max - 12))
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/')
}

function inferWebIdeEntryFile(filePath: string): string | null {
  const path = normalizePath(filePath)
  if (HTML_ENTRY_RE.test(path)) return path
  if (NEXT_PAGE_RE.test(path)) return path
  if (!NEXT_APP_FILE_RE.test(path) && !NEXT_COMPONENT_FILE_RE.test(path)) return null

  return path.includes('/src/app/') || path.startsWith('src/app/') || path.startsWith('src/components/')
    ? 'src/app/page.tsx'
    : 'app/page.tsx'
}

export class WebIdeHandler {
  private fileContentAccum: Record<string, string> = {}
  private filePathByEventId: Record<string, string> = {}
  private fileToolByEventId: Record<string, string> = {}
  private fileInitialContentByEventId: Record<string, string> = {}
  private fileContentByPath: Record<string, string> = {}
  private pendingWebIdeContentByEventId: Record<string, string> = {}

  private isActiveConversation(conversationId: string): boolean {
    return useChatStore.getState().activeId === conversationId
  }

  hydrateFromMessage(message: Message): void {
    for (const item of message.computerPanelData || []) {
      if (item.type !== 'file') continue
      const data = item.data as FileResult | undefined
      if (!data?.path || typeof data.content !== 'string') continue

      this.filePathByEventId[item.id] = data.path
      this.fileContentAccum[item.id] = data.content
      this.fileContentByPath[data.path] = data.content
      this.fileToolByEventId[item.id] = data.action === 'appended'
        ? 'append_file'
        : data.action === 'edited'
          ? 'edit_file'
          : 'create_file'
    }
  }

  private getExistingFileContent(conversationId: string, filePath: string): string {
    const uiState = useUIStore.getState()
    const streamingFile = uiState.webIdeConversationId === conversationId
      ? uiState.webIdeStreamingFile
      : null
    if (streamingFile?.path === filePath) return streamingFile.content
    if (this.fileContentByPath[filePath] !== undefined) return this.fileContentByPath[filePath]

    const conversation = useChatStore.getState().conversations.find((c) => c.id === conversationId)
    const assistantMessages = conversation?.messages.filter((m) => m.role === 'assistant') || []
    for (let mi = assistantMessages.length - 1; mi >= 0; mi--) {
      const items = assistantMessages[mi].computerPanelData || []
      for (let ii = items.length - 1; ii >= 0; ii--) {
        const item = items[ii]
        if (item.type !== 'file') continue
        const data = item.data as FileResult | undefined
        if (data?.path === filePath && typeof data.content === 'string') {
          return data.content
        }
      }

      const artifacts = assistantMessages[mi].artifacts || []
      for (let ai = artifacts.length - 1; ai >= 0; ai--) {
        const artifact = artifacts[ai]
        if (artifact.filePath === filePath && typeof artifact.content === 'string') {
          return artifact.content
        }
      }
    }

    return ''
  }

  handleFileContentStart(
    eventId: string,
    filePath: string,
    toolName: string | undefined,
    conversationId: string,
    upsertPanel: (convId: string, item: ComputerPanelItem) => void,
    openPanel: () => void,
  ): void {
    const uiState = useUIStore.getState()
    const isActiveConversation = this.isActiveConversation(conversationId)
    const entryFile = inferWebIdeEntryFile(filePath)
    const isAppend = toolName === 'append_file'
    const isEdit = toolName === 'edit_file'
    const existingForEvent = this.filePathByEventId[eventId] === filePath && this.fileContentAccum[eventId] !== undefined
    const initialContent = existingForEvent
      ? this.fileContentAccum[eventId]
      : isAppend ? this.getExistingFileContent(conversationId, filePath) : ''
    const action = isEdit ? 'edited' as const : isAppend ? 'appended' as const : 'created' as const
    const titleVerb = isEdit ? 'Editing' : isAppend ? 'Appending' : 'Writing'

    if (isActiveConversation && entryFile && (!uiState.webIdeMode || uiState.webIdeEntryFile !== entryFile)) {
      uiState.activateWebIde(conversationId, entryFile, { source: 'auto' })
    }

    if (isActiveConversation) {
      uiState.setWebIdeStreamingFile({ path: filePath, content: initialContent })
      uiState.setWebIdeSelectedFile(filePath)
    }
    if (isActiveConversation && uiState.webIdeMode) {
      uiState.setWebIdeActiveTab('code')
    }

    this.filePathByEventId[eventId] = filePath
    this.fileToolByEventId[eventId] = toolName || 'create_file'
    if (this.fileInitialContentByEventId[eventId] === undefined) {
      this.fileInitialContentByEventId[eventId] = initialContent
    }
    this.fileContentAccum[eventId] = initialContent
    this.fileContentByPath[filePath] = initialContent
    upsertPanel(conversationId, {
      id: eventId,
      type: 'file',
      title: `${titleVerb}: ${filePath.split('/').pop() || 'file'}`,
      data: { action, path: filePath, content: initialContent } as FileResult,
      timestamp: Date.now(),
      streaming: true,
    })
    openPanel()
  }

  handleFileContentDelta(
    eventId: string,
    content: string,
    conversationId: string,
    upsertPanel: (convId: string, item: ComputerPanelItem) => void,
  ): void {
    // Buffer content — flushed in batched callback via flushPendingWebIdeContent()
    this.pendingWebIdeContentByEventId[eventId] = (this.pendingWebIdeContentByEventId[eventId] || '') + content

    // Guard: initialize accumulator if delta arrives before start event
    if (this.fileContentAccum[eventId] === undefined) {
      this.fileContentAccum[eventId] = ''
    }

    if (this.fileContentAccum[eventId] !== undefined) {
      this.fileContentAccum[eventId] += content
      if (this.fileContentAccum[eventId].length > MAX_FILE_CONTENT_ACCUM) {
        this.fileContentAccum[eventId] = capStr(this.fileContentAccum[eventId], MAX_FILE_CONTENT_ACCUM)
      }

      const uiState = useUIStore.getState()
      const activeStreamingPath = this.isActiveConversation(conversationId) && uiState.webIdeConversationId === conversationId
        ? uiState.webIdeStreamingFile?.path
        : undefined
      const filePath = this.filePathByEventId[eventId] || activeStreamingPath || ''
      const isAppend = this.fileToolByEventId[eventId] === 'append_file'
      const isEdit = this.fileToolByEventId[eventId] === 'edit_file'
      const action = isEdit ? 'edited' as const : isAppend ? 'appended' as const : 'created' as const
      const titleVerb = isEdit ? 'Editing' : isAppend ? 'Appending' : 'Writing'
      if (filePath) this.fileContentByPath[filePath] = this.fileContentAccum[eventId]
      upsertPanel(conversationId, {
        id: eventId,
        type: 'file',
        title: `${titleVerb}: ${filePath.split('/').pop() || 'file'}`,
        data: { action, path: filePath, content: this.fileContentAccum[eventId] } as FileResult,
        timestamp: Date.now(),
        streaming: true,
      })
    }
  }

  handleToolResult(eventId: string, eventName: string, eventResult: unknown, conversationId: string): void {
    if (eventName !== 'create_file' && eventName !== 'append_file' && eventName !== 'edit_file') return

    const uiState = useUIStore.getState()
    const isActiveConversation = this.isActiveConversation(conversationId)
    const isActiveWebIde = isActiveConversation && uiState.webIdeConversationId === conversationId
    const result = eventResult as {
      path?: string
      content?: string
      nextWebsitePreviewUrl?: string
      error?: string
      superseded?: boolean
      discarded?: boolean
    }
    const createdPath = result?.path || this.filePathByEventId[eventId] || ''
    const abandoned =
      result?.superseded === true ||
      result?.discarded === true ||
      (
        typeof result?.error === 'string' &&
        /^(?:INTERNAL_RECOVERY:|FINAL_STEP_REDIRECT:)/i.test(result.error)
      )

    if (abandoned) {
      const initialContent = this.fileInitialContentByEventId[eventId]
      if (createdPath) {
        if (initialContent !== undefined) {
          this.fileContentByPath[createdPath] = initialContent
        } else {
          delete this.fileContentByPath[createdPath]
        }
      }
      if (isActiveConversation && (!createdPath || uiState.webIdeStreamingFile?.path === createdPath)) {
        uiState.setWebIdeStreamingFile(null)
      }
      return
    }

    let previewUrlApplied = false
    if (isActiveWebIde && typeof result?.nextWebsitePreviewUrl === 'string' && result.nextWebsitePreviewUrl.trim()) {
      uiState.setWebIdePreviewUrl(result.nextWebsitePreviewUrl)
      uiState.incrementWebIdeRefresh()
      uiState.setWebIdeActiveTab('preview')
      previewUrlApplied = true
    }
    if (createdPath && typeof result?.content === 'string') {
      this.fileContentByPath[createdPath] = result.content
      if (isActiveConversation && uiState.webIdeStreamingFile?.path === createdPath) {
        uiState.setWebIdeStreamingFile({ path: createdPath, content: result.content })
      }
    } else if (createdPath && this.fileContentAccum[eventId] !== undefined) {
      this.fileContentByPath[createdPath] = this.fileContentAccum[eventId]
    }
    if (isActiveConversation && (!createdPath || uiState.webIdeStreamingFile?.path === createdPath)) {
      uiState.setWebIdeStreamingFile(null)
    }
    if (isActiveWebIde && uiState.webIdeMode) {
      const isEntryFile = createdPath === uiState.webIdeEntryFile
      if (!previewUrlApplied && isEntryFile) {
        uiState.incrementWebIdeRefresh()
        uiState.setWebIdeActiveTab('preview')
      } else if (!previewUrlApplied && uiState.webIdeRefreshKey > 0) {
        uiState.incrementWebIdeRefresh()
      }
    }
  }

  /** Flush buffered WebIDE content in a single store update (called from batch scheduler) */
  flushPendingWebIdeContent(eventId: string, conversationId: string): void {
    const content = this.pendingWebIdeContentByEventId[eventId]
    delete this.pendingWebIdeContentByEventId[eventId]
    if (!content || !this.isActiveConversation(conversationId)) return

    const uiState = useUIStore.getState()
    const filePath = this.filePathByEventId[eventId]
    if (
      uiState.webIdeStreamingFile?.path === filePath
    ) {
      uiState.appendWebIdeStreamingContent(content)
    }
  }

  deleteAccum(eventId: string): void {
    delete this.filePathByEventId[eventId]
    delete this.fileToolByEventId[eventId]
    delete this.fileInitialContentByEventId[eventId]
    delete this.fileContentAccum[eventId]
    delete this.pendingWebIdeContentByEventId[eventId]
  }

  cleanup(conversationId: string): void {
    this.fileContentAccum = {}
    this.filePathByEventId = {}
    this.fileToolByEventId = {}
    this.fileInitialContentByEventId = {}
    this.pendingWebIdeContentByEventId = {}
    if (this.isActiveConversation(conversationId)) {
      const uiState = useUIStore.getState()
      uiState.setWebIdeStreamingFile(null)
    }
  }
}
