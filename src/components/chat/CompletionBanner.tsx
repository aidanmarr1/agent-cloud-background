'use client'

import { useState } from 'react'
import { Check, Clock, Globe, ChevronRight, Search, Terminal, FilePlus, FileText, Code, Edit3, Loader2, Zap, X } from '@/components/icons'
import { TaskGroup, Subtask } from '@/types'
import { isHiddenSubtaskActivity } from '@/lib/stream/constants'

interface CompletionBannerProps {
  completedSteps: number
  totalSteps: number
  elapsedMs?: number
  sourceCount?: number
  taskGroups?: TaskGroup[]
}

const iconMap: Record<string, React.ReactNode> = {
  search: <Search size={11} />,
  terminal: <Terminal size={11} />,
  browse: <Globe size={11} />,
  create_file: <FilePlus size={11} />,
  read_file: <FileText size={11} />,
  edit_file: <Edit3 size={11} />,
  append_file: <Edit3 size={11} />,
  export_pdf: <FileText size={11} />,
  run_code: <Code size={11} />,
  browser: <Globe size={11} />,
}

function TimelineModal({ taskGroups, elapsedMs, completedSteps, totalSteps, sourceCount, onClose }: {
  taskGroups: TaskGroup[]
  elapsedMs?: number
  completedSteps: number
  totalSteps: number
  sourceCount?: number
  onClose: () => void
}) {
  const allSubtasks: Array<{ subtask: Subtask; groupTitle: string }> = []
  for (const group of taskGroups) {
    const subtasks = Array.isArray(group.subtasks) ? group.subtasks : []
    for (const subtask of subtasks) {
      if (isHiddenSubtaskActivity(subtask)) continue
      if (!subtask.label?.trim()) continue
      allSubtasks.push({ subtask, groupTitle: group.title })
    }
  }

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return `${m}m ${s % 60}s`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <button
        type="button"
        className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close task timeline"
      />
      <div
        className="relative bg-bg-primary border border-border-primary rounded-2xl max-w-lg w-full mx-4 max-h-[70vh] flex flex-col animate-scale-in overflow-hidden"
        style={{ boxShadow: 'var(--shadow-xl)' }}
      >
        <div className="px-5 h-14 border-b border-border-primary flex items-center justify-between flex-shrink-0">
          <h3 className="text-[16px] font-semibold text-text-primary tracking-[0] [font-family:var(--font-display)]">Task timeline</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
            aria-label="Close"
          >
            <X size={14} strokeWidth={2.25} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {allSubtasks.map(({ subtask }) => {
            const icon = iconMap[subtask.type] || <Globe size={11} />
            const isDone = subtask.status === 'done'
            return (
              <div key={subtask.id} className="flex items-center gap-2.5 py-2 rounded-lg px-2.5 hover:bg-bg-secondary transition-all duration-150">
                {isDone ? (
                  <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
                    <Check size={11} className="text-text-secondary" strokeWidth={3} />
                  </div>
                ) : (
                  <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
                    <Loader2 size={11} className="text-accent-blue" style={{ animation: 'spin 1.5s linear infinite' }} strokeWidth={2.5} />
                  </div>
                )}
                <span className="text-text-muted flex-shrink-0">{icon}</span>
                <span className="text-[13px] text-text-secondary truncate flex-1 tracking-[0]">
                  {subtask.label}
                </span>
              </div>
            )
          })}
        </div>
        <div className="px-5 h-11 border-t border-border-primary text-[11px] text-text-muted flex items-center gap-4 flex-shrink-0 tabular-nums">
          <span className="font-semibold text-text-tertiary">{allSubtasks.length} tool calls</span>
          {totalSteps > 0 && <span>{completedSteps}/{totalSteps} steps</span>}
          {elapsedMs && elapsedMs > 1000 && <span>{formatTime(elapsedMs)}</span>}
          {sourceCount && sourceCount > 0 && <span>{sourceCount} sources</span>}
        </div>
      </div>
    </div>
  )
}

function formatElapsed(ms: number) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export function CompletionBanner({ completedSteps, totalSteps, elapsedMs, sourceCount, taskGroups }: CompletionBannerProps) {
  const [showTimeline, setShowTimeline] = useState(false)

  return (
    <>
      <div className="flex items-center gap-3 py-4 mb-4 border-t border-border-primary animate-fade-in">
        <div className="w-6 h-6 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0 animate-completion-ring">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-text-secondary">
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="24"
              strokeDashoffset="0"
              className="animate-checkmark-draw"
            />
          </svg>
        </div>
        <span className="text-[13px] font-semibold text-text-primary tracking-[0]">Task completed</span>

        {elapsedMs && elapsedMs > 1000 && (
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted tabular-nums">
            <span className="w-1 h-1 rounded-full bg-text-muted/40" />
            {formatElapsed(elapsedMs)}
          </div>
        )}
        {sourceCount && sourceCount > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-text-muted tabular-nums">
            <span className="w-1 h-1 rounded-full bg-text-muted/40" />
            {sourceCount} sources
          </div>
        )}

        <div className="flex-1" />

        {taskGroups && taskGroups.length > 0 && (
          <button
            onClick={() => setShowTimeline(true)}
            aria-label="Show task details"
            className="flex items-center gap-1 text-[11.5px] font-medium text-text-muted hover:text-text-primary transition-all duration-150 px-2.5 h-7 rounded-md hover:bg-bg-secondary"
          >
            Details
            <ChevronRight size={11} />
          </button>
        )}
      </div>
      {showTimeline && taskGroups && (
        <TimelineModal
          taskGroups={taskGroups}
          elapsedMs={elapsedMs}
          completedSteps={completedSteps}
          totalSteps={totalSteps}
          sourceCount={sourceCount}
          onClose={() => setShowTimeline(false)}
        />
      )}
    </>
  )
}
