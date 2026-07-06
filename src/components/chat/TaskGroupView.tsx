'use client'

import { useState, useEffect, memo } from 'react'
import { ChevronRight, Check, Search, Globe, Terminal, FilePlus, FileText, Trash2, FolderOpen, Loader2, Code, FileCode, Link, MonitorPlay, Edit3, BookOpen, AlertTriangle } from '@/components/icons'
import { TaskGroup, Subtask, GroupNarration } from '@/types'
import { useUIStore } from '@/store/ui'
import { sanitizeNarrationText } from '@/lib/stream/cleaners'
import { isHiddenSubtaskActivity } from '@/lib/stream/constants'
import { formatVisibleActionLabel } from '@/lib/stream/ActivityDescriber'
import { MarkdownLite } from './MarkdownLite'

interface TaskGroupViewProps {
  group: TaskGroup
}

const INLINE_THINKING_DELAY_MS = 1200

const iconMap: Record<string, React.ReactNode> = {
  search: <Search size={13} className="flex-shrink-0" />,
  terminal: <Terminal size={13} className="flex-shrink-0" />,
  browse: <Globe size={13} className="flex-shrink-0" />,
  create_file: <FilePlus size={13} className="flex-shrink-0" />,
  read_file: <FileText size={13} className="flex-shrink-0" />,
  read_skill: <BookOpen size={13} className="flex-shrink-0" />,
  delete_file: <Trash2 size={13} className="flex-shrink-0" />,
  list_files: <FolderOpen size={13} className="flex-shrink-0" />,
  edit_file: <Edit3 size={13} className="flex-shrink-0" />,
  append_file: <Edit3 size={13} className="flex-shrink-0" />,
  export_pdf: <FileText size={13} className="flex-shrink-0" />,
  run_code: <Code size={13} className="flex-shrink-0" />,
  youtube_transcript: <MonitorPlay size={13} className="flex-shrink-0" />,
  read_document: <FileCode size={13} className="flex-shrink-0" />,
  http_request: <Link size={13} className="flex-shrink-0" />,
  browser: <Globe size={13} className="flex-shrink-0" />,
}

const colorMap: Record<string, string> = {
  search: 'text-text-tertiary',
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
  youtube_transcript: 'text-accent-red',
  read_document: 'text-text-secondary',
  http_request: 'text-text-tertiary',
}

function InlineThinkingIndicator() {
  return (
    <div
      className="mb-2 flex items-center gap-3 py-1.5 text-text-secondary animate-fade-in"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center">
        <span className="h-2.5 w-2.5 rounded-full bg-status-live" style={{ animation: 'pulse-dot 1.8s ease-in-out infinite' }} />
      </span>
      <span className="chat-task-body text-[15px] font-medium tracking-[0]">Thinking</span>
    </div>
  )
}

const ActionPill = memo(function ActionPill({ subtask }: { subtask: Subtask }) {
  const setComputerPanelOpen = useUIStore((s) => s.setComputerPanelOpen)
  const isDone = subtask.status === 'done'
  const isRunning = subtask.status === 'running'
  const icon = iconMap[subtask.type] || <Globe size={13} className="flex-shrink-0" />
  const label = formatVisibleActionLabel(subtask.label || '')
  if (!label) return null

  return (
    <button
      type="button"
      onClick={() => { if (isDone && subtask.result) setComputerPanelOpen(true, { source: 'user' }) }}
      aria-label={isDone && subtask.result ? `Open ${label}` : label}
      className={`inline-flex h-7 max-w-full items-center gap-1.5 overflow-hidden rounded-[11px] border pl-2 pr-2.5 transition-colors duration-150 ${
        isDone
          ? 'border-border-primary bg-bg-primary cursor-pointer hover:bg-bg-secondary hover:border-border-tertiary'
        : isRunning
            ? 'border-border-tertiary bg-bg-secondary cursor-default'
            : 'border-border-primary bg-bg-primary cursor-default'
      }`}
    >
      <span className={isRunning ? 'text-text-secondary' : (colorMap[subtask.type] || 'text-text-tertiary')}>{icon}</span>
      <span className={`chat-action-pill truncate ${isRunning ? 'text-text-primary font-semibold' : 'text-text-secondary font-medium'}`}>
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

export function TaskGroupView({ group }: TaskGroupViewProps) {
  const isAppStreaming = useUIStore((s) => s.isStreaming)
  const streamingStatus = useUIStore((s) => s.streamingStatus)
  const isRunning = group.status === 'running'
  const isDone = group.status === 'done'
  const isIncomplete = group.status === 'incomplete'
  const isError = group.status === 'error'
  const [expanded, setExpanded] = useState(group.status !== 'pending')
  const [inlineThinkingReady, setInlineThinkingReady] = useState(false)

  useEffect(() => {
    if (isRunning) setExpanded(true)
  }, [isRunning])

  const visibleSubtasks = group.subtasks.filter((s) => !isHiddenSubtaskActivity(s))
  const doneCount = visibleSubtasks.filter((s) => s.status === 'done').length
  const totalCount = visibleSubtasks.length
  const hasRunningVisibleSubtask = visibleSubtasks.some((s) => s.status === 'running')
  const inlineThinkingEligible = isAppStreaming && isRunning && !hasRunningVisibleSubtask && streamingStatus !== 'startup'
  const showInlineThinking = inlineThinkingEligible && inlineThinkingReady

  useEffect(() => {
    if (!inlineThinkingEligible) {
      setInlineThinkingReady(false)
      return
    }

    const timer = window.setTimeout(() => setInlineThinkingReady(true), INLINE_THINKING_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [inlineThinkingEligible, group.id, totalCount])

  return (
    <div>
      {/* Group header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 py-1.5 hover:bg-bg-secondary rounded-xl px-2.5 -mx-2 transition-colors duration-150"
        aria-expanded={expanded}
      >
        {isRunning ? (
          <div className="w-[18px] h-[18px] rounded-full bg-bg-primary border border-border-primary flex items-center justify-center flex-shrink-0">
            <Loader2
              size={11}
              className="text-text-secondary flex-shrink-0"
              style={{ animation: 'spin 1.2s linear infinite' }}
            />
          </div>
        ) : isDone ? (
          <div className="w-[18px] h-[18px] rounded-full bg-bg-primary border border-border-primary flex items-center justify-center flex-shrink-0">
            <Check size={10} className="text-text-tertiary" strokeWidth={3} />
          </div>
        ) : isIncomplete ? (
          <div className="w-[18px] h-[18px] rounded-full bg-bg-primary border border-border-primary flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={10} className="text-text-tertiary" strokeWidth={2.5} />
          </div>
        ) : isError ? (
          <div className="w-[18px] h-[18px] rounded-full bg-danger-bg border border-danger-border flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={10} className="text-danger-icon" strokeWidth={2.5} />
          </div>
        ) : (
          <div className="w-[18px] h-[18px] rounded-full border border-border-tertiary flex-shrink-0" />
        )}

        <span className="chat-task-title flex-1 text-left truncate font-semibold text-text-primary tracking-[0]">
          {group.title}
        </span>

        {totalCount > 0 && (
          <span className={`text-[10px] tabular-nums font-semibold px-1.5 py-0.5 rounded-full border ${
            doneCount === totalCount && isDone
              ? 'bg-bg-primary text-text-secondary border-border-primary'
              : isIncomplete
                ? 'bg-bg-primary text-text-secondary border-border-primary'
              : isError
                ? 'bg-danger-bg text-danger-text border-danger-border'
              : 'bg-bg-primary text-text-muted border-border-primary'
          }`}>
            {isIncomplete ? 'Incomplete' : `${doneCount}/${totalCount}`}
          </span>
        )}

        <ChevronRight
          size={14}
          className={`text-text-muted transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          strokeWidth={2.25}
        />
      </button>

      {/* Expanded body */}
      {expanded && (
        <>
          <div className="task-thread-body relative ml-[9px] pl-6 pb-2 pt-0.5">
            {(() => {
              const items: Array<{ kind: 'subtask'; data: Subtask } | { kind: 'narration'; data: GroupNarration }> = []
              const narrations = [...(group.narrations || [])].sort((a, b) => a.position - b.position)
              let narrationIdx = 0
              group.subtasks.forEach((subtask, i) => {
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
                    <div key={idx} className="flex flex-col items-start gap-1.5 mb-1.5">
                      {cluster.items.map((subtask) => (
                        <ActionPill key={subtask.id} subtask={subtask} />
                      ))}
                    </div>
                  )
                }

                const narrationText = sanitizeNarrationText(cluster.data.text)
                if (!narrationText) return null

                return (
                  <div key={cluster.data.id} className="task-narration-note chat-task-body text-text-secondary mb-2 animate-narration-in markdown-content">
                    <MarkdownLite>{narrationText}</MarkdownLite>
                  </div>
                )
              })
            })()}

            {group.synthesis && (
              <div className="task-narration-note chat-task-body text-text-secondary markdown-content">
                <MarkdownLite>{group.synthesis}</MarkdownLite>
              </div>
            )}
          </div>

          {showInlineThinking && (
            <div className="task-inline-thinking-row ml-[9px] pl-6 pb-2 pt-0.5">
              <InlineThinkingIndicator />
            </div>
          )}
        </>
      )}
    </div>
  )
}
