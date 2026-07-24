'use client'

import { useState, useEffect, memo } from 'react'
import { ChevronRight, Check, Search, ImageSearch, Compass, Globe, Terminal, FilePlus, FileText, Trash2, FolderOpen, Loader2, Code, FileCode, Link, Edit3, BookOpen, AlertTriangle } from '@/components/icons'
import { TaskGroup, Subtask, GroupNarration } from '@/types'
import { useUIStore } from '@/store/ui'
import { sanitizeNarrationText } from '@/lib/stream/cleaners'
import { isHiddenSubtaskActivity } from '@/lib/stream/constants'
import { formatVisibleActionLabel } from '@/lib/stream/ActivityDescriber'
import { MarkdownLite } from './MarkdownLite'

interface TaskGroupViewProps {
  group: TaskGroup
  isCurrentGroup?: boolean
}

const INLINE_THINKING_DELAY_MS = 1200

const iconMap: Record<string, React.ReactNode> = {
  search: <Search size={13} className="flex-shrink-0" />,
  image_search: <ImageSearch size={14} className="flex-shrink-0" />,
  terminal: <Terminal size={13} className="flex-shrink-0" />,
  browse: <Compass size={12} className="flex-shrink-0" weight="bold" />,
  create_file: <FilePlus size={13} className="flex-shrink-0" />,
  read_file: <FileText size={13} className="flex-shrink-0" />,
  read_skill: <BookOpen size={13} className="flex-shrink-0" />,
  delete_file: <Trash2 size={13} className="flex-shrink-0" />,
  list_files: <FolderOpen size={13} className="flex-shrink-0" />,
  edit_file: <Edit3 size={13} className="flex-shrink-0" />,
  append_file: <Edit3 size={13} className="flex-shrink-0" />,
  export_pdf: <FileText size={13} className="flex-shrink-0" />,
  run_code: <Code size={13} className="flex-shrink-0" />,
  read_document: <FileCode size={13} className="flex-shrink-0" />,
  http_request: <Link size={13} className="flex-shrink-0" />,
  browser: <Compass size={12} className="flex-shrink-0" weight="bold" />,
}

const colorMap: Record<string, string> = {
  search: 'text-text-tertiary',
  image_search: 'text-text-tertiary',
  browse: 'text-text-secondary',
  terminal: 'text-text-secondary',
  create_file: 'text-text-secondary',
  edit_file: 'text-text-secondary',
  append_file: 'text-text-secondary',
  export_pdf: 'text-text-secondary',
  read_file: 'text-text-tertiary',
  read_skill: 'text-text-tertiary',
  delete_file: 'text-accent-red',
  run_code: 'text-text-secondary',
  browser: 'text-text-secondary',
  list_files: 'text-text-tertiary',
  read_document: 'text-text-secondary',
  http_request: 'text-text-tertiary',
}

function InlineThinkingIndicator() {
  return (
    <div
      className="task-activity-row mb-1.5 flex items-center gap-1 py-1 text-text-secondary animate-fade-in"
      role="status"
      aria-live="polite"
    >
      <span className="task-activity-marker relative flex h-5 w-5 flex-shrink-0 items-center justify-start">
        <span className="h-2 w-2 rounded-full bg-status-live" style={{ animation: 'pulse-dot 1.8s ease-in-out infinite' }} />
      </span>
      <span className="text-[14px] font-normal leading-5 tracking-[0]">Thinking</span>
    </div>
  )
}

const ActionPill = memo(function ActionPill({ subtask }: { subtask: Subtask }) {
  const setComputerPanelOpen = useUIStore((s) => s.setComputerPanelOpen)
  const isDone = subtask.status === 'done'
  const isRunning = subtask.status === 'running'
  const isError = subtask.status === 'error'
  const canOpen = isDone && Boolean(subtask.result)
  const icon = iconMap[subtask.type] || <Globe size={13} className="flex-shrink-0" />
  const label = formatVisibleActionLabel(subtask.label || '')
  const isCompassAction = subtask.type === 'browse' || subtask.type === 'browser'
  if (!label) return null

  return (
    <button
      type="button"
      onClick={() => { if (canOpen) setComputerPanelOpen(true, { source: 'user' }) }}
      aria-label={canOpen ? `Open ${label}` : label}
      className={`group/action flex min-h-7 max-w-full items-center gap-1 py-1 text-left transition-colors duration-150 ${
        isError
          ? 'cursor-default text-danger-text'
          : isRunning
            ? 'cursor-default'
            : canOpen
              ? 'cursor-pointer'
              : isDone
                ? 'cursor-default'
                : 'cursor-default'
      }`}
    >
      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center border border-border-tertiary bg-bg-secondary ${
        isCompassAction ? 'rounded-full' : 'rounded-[5px]'
      } ${
        isError
          ? 'text-danger-icon'
          : isRunning
            ? 'text-accent-blue'
            : colorMap[subtask.type] || 'text-text-tertiary'
      }`}>
        {icon}
      </span>
      <span className={`min-w-0 truncate text-[14px] leading-5 transition-colors duration-150 ${isError ? 'font-medium text-danger-text' : isRunning ? 'font-medium text-text-primary' : 'text-text-secondary group-hover/action:text-text-primary'}`}>
        {label}
      </span>
      {isRunning && (
        <Loader2
          size={11}
          className="text-text-secondary flex-shrink-0"
          style={{ animation: 'spin 1.5s linear infinite' }}
        />
      )}
    </button>
  )
})

export function TaskGroupView({ group, isCurrentGroup = false }: TaskGroupViewProps) {
  const isAppStreaming = useUIStore((s) => s.isStreaming)
  const streamingStatus = useUIStore((s) => s.streamingStatus)
  const isRunning = group.status === 'running'
  const isDone = group.status === 'done'
  const isIncomplete = group.status === 'incomplete'
  const isError = group.status === 'error'
  const [expanded, setExpanded] = useState(isRunning || isDone)
  const [inlineThinkingReady, setInlineThinkingReady] = useState(false)

  useEffect(() => {
    if (isRunning || isDone) setExpanded(true)
  }, [isRunning, isDone])

  const subtasks = Array.isArray(group.subtasks) ? group.subtasks : []
  const narrationsList = Array.isArray(group.narrations) ? group.narrations : []
  const visibleSubtasks = subtasks.filter((s) => !isHiddenSubtaskActivity(s))
  const totalCount = visibleSubtasks.length
  const hasRunningVisibleSubtask = visibleSubtasks.some((s) => s.status === 'running')
  const inlineThinkingEligible = isCurrentGroup && isAppStreaming && isRunning && !hasRunningVisibleSubtask && streamingStatus === 'thinking'
  const showInlineThinking = inlineThinkingEligible && inlineThinkingReady
  const detailsId = `task-group-${group.id}`

  useEffect(() => {
    if (!inlineThinkingEligible) {
      setInlineThinkingReady(false)
      return
    }

    const timer = window.setTimeout(() => setInlineThinkingReady(true), INLINE_THINKING_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [inlineThinkingEligible, group.id, totalCount])

  return (
    <div className="animate-fade-in">
      {/* Group header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="task-activity-row group/header flex h-7 w-full items-center gap-1 text-left text-text-secondary transition-colors duration-150 hover:text-text-primary"
        aria-expanded={expanded}
        aria-controls={detailsId}
      >
        {isRunning ? (
          <div className="task-activity-marker flex h-5 w-5 flex-shrink-0 items-center justify-start">
            <Loader2
              size={13}
              className="flex-shrink-0 text-accent-blue"
              style={{ animation: 'spin 1.2s linear infinite' }}
            />
          </div>
        ) : isDone ? (
          <div className="task-activity-marker flex h-5 w-5 flex-shrink-0 items-center justify-start">
            <span className="flex h-[17px] w-[17px] items-center justify-center rounded-full bg-bg-secondary">
              <Check size={10} className="text-text-tertiary" strokeWidth={3} />
            </span>
          </div>
        ) : isIncomplete ? (
          <div className="task-activity-marker flex h-5 w-5 flex-shrink-0 items-center justify-start">
            <AlertTriangle size={13} className="text-text-tertiary" strokeWidth={2.5} />
          </div>
        ) : isError ? (
          <div className="task-activity-marker flex h-5 w-5 flex-shrink-0 items-center justify-start">
            <AlertTriangle size={13} className="text-danger-icon" strokeWidth={2.5} />
          </div>
        ) : (
          <div className="task-activity-marker flex h-5 w-5 flex-shrink-0 items-center justify-start">
            <span className="h-[17px] w-[17px] rounded-full border border-border-tertiary" />
          </div>
        )}

        <span className={`min-w-0 flex-1 truncate text-[14px] font-normal leading-5 tracking-[0] ${
          isRunning ? 'text-text-primary' : isError ? 'text-danger-text' : isDone ? 'text-text-secondary' : 'text-text-tertiary'
        }`}>
          {group.title}
        </span>

        <ChevronRight
          size={13}
          className={`flex-shrink-0 text-text-muted opacity-0 transition-all duration-150 group-hover/header:opacity-100 group-focus-visible/header:opacity-100 ${expanded ? 'rotate-90' : ''}`}
          strokeWidth={2.25}
        />
      </button>

      {/* Expanded body */}
      {expanded && (
        <div id={detailsId}>
          <div className="task-thread-body relative pb-2.5 pl-6 pr-2 pt-0.5">
            {(() => {
              const items: Array<{ kind: 'subtask'; data: Subtask } | { kind: 'narration'; data: GroupNarration }> = []
              const narrations = [...narrationsList].sort((a, b) => a.position - b.position)
              let narrationIdx = 0
              subtasks.forEach((subtask, i) => {
                while (narrationIdx < narrations.length && narrations[narrationIdx].position <= i) {
                  items.push({ kind: 'narration', data: narrations[narrationIdx] })
                  narrationIdx++
                }
                if (isHiddenSubtaskActivity(subtask)) return
                items.push({ kind: 'subtask', data: subtask })
              })
              while (narrationIdx < narrations.length) {
                items.push({ kind: 'narration', data: narrations[narrationIdx] })
                narrationIdx++
              }

              // Group consecutive subtasks into pill clusters
              const clusters: Array<{ kind: 'pills'; items: Subtask[] } | { kind: 'narration'; data: GroupNarration }> = []
              for (const item of items) {
                if (item.kind === 'narration') {
                  clusters.push({ kind: 'narration', data: item.data })
                } else {
                  const last = clusters[clusters.length - 1]
                  if (last && last.kind === 'pills') {
                    last.items.push(item.data)
                  } else {
                    clusters.push({ kind: 'pills', items: [item.data] })
                  }
                }
              }

              return clusters.map((cluster, idx) => {
                if (cluster.kind === 'pills') {
                  return (
                    <div key={idx} className="mb-1.5 flex flex-col items-start gap-0.5">
                      {cluster.items.map((subtask) => (
                        <ActionPill key={subtask.id} subtask={subtask} />
                      ))}
                    </div>
                  )
                }

                const narrationText = sanitizeNarrationText(cluster.data.text)
                if (!narrationText) return null

                return (
                  <div key={cluster.data.id} className="task-narration-note chat-task-body mb-2 animate-narration-in text-text-secondary markdown-content [&_p]:my-0">
                    <MarkdownLite>{narrationText}</MarkdownLite>
                  </div>
                )
              })
            })()}

            {group.synthesis && (
              <div className="task-narration-note chat-task-body text-text-secondary markdown-content [&_p]:my-0">
                <MarkdownLite>{group.synthesis}</MarkdownLite>
              </div>
            )}
          </div>

          {showInlineThinking && (
            <div className="task-inline-thinking-row pb-2.5 pt-0.5">
              <InlineThinkingIndicator />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
