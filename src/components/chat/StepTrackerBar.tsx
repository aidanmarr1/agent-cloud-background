'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Check, Loader2, AlertTriangle } from '@/components/icons'
import { TaskGroup } from '@/types'

interface StepTrackerBarProps {
  taskGroups: TaskGroup[]
  isStreaming: boolean
}

export function StepTrackerBar({ taskGroups, isStreaming }: StepTrackerBarProps) {
  const [expanded, setExpanded] = useState(false)

  const doneCount = taskGroups.filter((group) => group.status === 'done').length
  const total = taskGroups.length
  const isComplete = total > 0 && doneCount === total
  const hasIssue = taskGroups.some((group) => group.status === 'error' || group.status === 'incomplete')
  const isActive = isStreaming && !isComplete && !hasIssue
  const currentGroup = taskGroups.find((group) => group.status === 'running')
    || taskGroups.find((group) => group.status === 'pending')
    || taskGroups[taskGroups.length - 1]
  const currentDisplayTitle = currentGroup?.title || 'Task progress'

  useEffect(() => {
    if (isComplete) setExpanded(false)
  }, [isComplete])

  if (total === 0) return null

  return (
    <div
      className="task-progress-surface relative z-[1] -mb-5 flex-shrink-0 overflow-hidden rounded-t-[22px] border border-border-primary bg-bg-card pb-[19px]"
    >
      <div>
        {!expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="group flex min-h-10 w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:text-text-primary"
            aria-expanded={false}
            aria-label={`${isComplete ? 'Task complete' : hasIssue ? 'Task needs attention' : 'Task in progress'}: ${doneCount} of ${total} steps. ${currentDisplayTitle}`}
          >
            <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
              {isComplete ? (
                <Check size={13} className="text-success-icon" strokeWidth={3} />
              ) : hasIssue ? (
                <AlertTriangle size={13} className="text-danger-icon" strokeWidth={2.25} />
              ) : isActive ? (
                <Loader2 size={13} className="text-accent-blue" style={{ animation: 'spin 1.2s linear infinite' }} />
              ) : (
              <span className="h-2 w-2 rounded-full bg-text-muted" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] leading-5 text-text-primary">
              {currentDisplayTitle}
            </span>
            <span className="flex-shrink-0 text-[13px] tabular-nums text-text-muted group-hover:opacity-80">
              {doneCount} / {total}
            </span>
            <ChevronDown size={16} className="flex-shrink-0 text-text-muted transition-transform duration-150 group-hover:opacity-80" />
          </button>
        ) : (
          <div className="animate-fade-in">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="group flex min-h-10 w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:text-text-primary"
              aria-expanded={true}
              aria-label="Collapse task progress"
            >
              <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                {isComplete ? (
                  <Check size={13} className="text-success-icon" strokeWidth={3} />
                ) : hasIssue ? (
                  <AlertTriangle size={13} className="text-danger-icon" />
                ) : isActive ? (
                  <Loader2 size={13} className="text-accent-blue" style={{ animation: 'spin 1.2s linear infinite' }} />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-text-muted" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] leading-5 text-text-primary">{currentDisplayTitle}</span>
              <span className="text-[13px] tabular-nums text-text-muted group-hover:opacity-80">{doneCount} / {total}</span>
              <ChevronDown size={16} className="rotate-180 text-text-muted group-hover:opacity-80" />
            </button>

            <div className="px-4 pb-3">
              <div className="text-[14px] leading-5 text-text-muted">Task progress</div>
              <div className="mb-3 mt-2 max-h-[min(240px,32vh)] space-y-2 overflow-y-auto overflow-x-hidden">
              {taskGroups.map((group) => (
                <div
                  key={group.id}
                  className="flex min-w-0 items-center gap-2"
                >
                  {group.status === 'done' ? (
                    <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                      <Check size={16} className="text-success-icon" strokeWidth={2.5} />
                    </span>
                  ) : group.status === 'running' ? (
                    <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                      <Loader2 size={14} className="text-accent-blue" style={{ animation: 'spin 1.2s linear infinite' }} />
                    </span>
                  ) : group.status === 'error' || group.status === 'incomplete' ? (
                    <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                      <AlertTriangle size={14} className="text-danger-icon" />
                    </span>
                  ) : (
                    <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                      <span className="h-2 w-2 rounded-full border border-border-tertiary" />
                    </span>
                  )}
                  <span className={`min-w-0 flex-1 truncate text-[14px] leading-5 ${
                    group.status === 'running'
                      ? 'font-medium text-text-primary'
                      : group.status === 'done'
                        ? 'text-text-primary'
                        : group.status === 'error' || group.status === 'incomplete'
                          ? 'font-medium text-danger-text'
                          : 'text-text-muted'
                  }`}>
                    {group.status === 'incomplete' && <span className="sr-only">Incomplete: </span>}
                    {group.title}
                  </span>
                </div>
              ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
