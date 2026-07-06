'use client'

import { useState, useEffect, useRef } from 'react'
import { ChevronRight, ChevronDown, Check, Loader2, AlertTriangle } from '@/components/icons'
import { TaskGroup } from '@/types'

interface StepTrackerBarProps {
  taskGroups: TaskGroup[]
  isStreaming: boolean
}

export function StepTrackerBar({ taskGroups, isStreaming }: StepTrackerBarProps) {
  const [expanded, setExpanded] = useState(false)

  const doneCount = taskGroups.filter((g) => g.status === 'done').length
  const incompleteCount = taskGroups.filter((g) => g.status === 'incomplete').length
  const total = taskGroups.length
  const allDone = total > 0 && doneCount === total && !isStreaming
  const hasIncomplete = incompleteCount > 0
  const currentGroup = taskGroups.find((g) => g.status === 'running') || taskGroups.find((g) => g.status === 'incomplete')
  const currentDisplayTitle = currentGroup?.title
    || (doneCount > 0 ? taskGroups[Math.min(doneCount, total) - 1]?.title : taskGroups[0]?.title)
    || (isStreaming ? 'Thinking...' : 'Task progress')

  const [justCompleted, setJustCompleted] = useState(false)
  const prevAllDone = useRef(false)
  useEffect(() => {
    if (allDone && !prevAllDone.current) {
      setJustCompleted(true)
      const timer = setTimeout(() => setJustCompleted(false), 2000)
      return () => clearTimeout(timer)
    }
    prevAllDone.current = allDone
  }, [allDone])

  if (total <= 1) return null

  const progressPercent = total > 0 ? (doneCount / total) * 100 : 0

  return (
    <div className="flex-shrink-0">
      <div className="max-w-[820px] mx-auto px-3 sm:px-4">
        <div
          className={`border rounded-2xl overflow-hidden mb-3 bg-bg-card transition-colors duration-300 ${justCompleted ? 'border-border-primary' : 'border-border-primary'}`}
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          {/* Progress bar */}
          <div className="h-[3px] bg-bg-tertiary">
            <div
              className={`h-full transition-all ${allDone ? 'bg-text-secondary' : 'bg-accent-blue'}`}
              style={{ width: `${progressPercent}%`, transitionDuration: '0.8s', transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
            />
          </div>

          {/* Expanded step list */}
          {expanded && total > 1 && (
            <div className="px-3.5 pt-4 pb-3 animate-fade-in sm:px-5 sm:pt-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[14.5px] font-semibold text-text-primary [font-family:var(--font-display)] tracking-[0]">Task progress</span>
                <span className="text-[11.5px] text-text-muted tabular-nums font-semibold bg-bg-secondary border border-border-primary rounded-md px-1.5 py-0.5">{doneCount} / {total}</span>
              </div>
              <div className="space-y-0.5">
                {taskGroups.map((group) => (
                  <div
                    key={group.id}
                    className={`flex items-center gap-3 py-2.5 px-2.5 rounded-lg transition-all duration-150 ${
                      group.status === 'running'
                        ? 'bg-bg-secondary'
                        : 'hover:bg-bg-secondary'
                    }`}
                  >
                    {group.status === 'done' ? (
                      <div className="w-5 h-5 rounded-full bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                        <Check size={11} className="text-text-secondary" strokeWidth={3} />
                      </div>
                    ) : group.status === 'incomplete' ? (
                      <div className="w-5 h-5 rounded-full bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                        <AlertTriangle size={11} className="text-text-secondary" strokeWidth={2.5} />
                      </div>
                    ) : group.status === 'running' ? (
                      <div className="w-5 h-5 rounded-full bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                        <Loader2
                          size={12}
                          className="text-accent-blue flex-shrink-0"
                          style={{ animation: 'spin 1.2s linear infinite' }}
                        />
                      </div>
                    ) : group.status === 'error' ? (
                      <div className="w-5 h-5 rounded-full bg-accent-red/10 border border-accent-red/20 flex items-center justify-center flex-shrink-0">
                        <AlertTriangle size={11} className="text-accent-red" strokeWidth={2.5} />
                      </div>
                    ) : (
                      <div className="w-5 h-5 rounded-full border border-border-tertiary flex-shrink-0" />
                    )}
                    <span
                      className={`chat-task-body flex-1 ${
                        group.status === 'running'
                          ? 'text-text-primary font-semibold'
                          : group.status === 'done'
                            ? 'text-text-secondary font-medium'
                            : group.status === 'incomplete'
                              ? 'text-text-secondary font-medium'
                            : group.status === 'error'
                              ? 'text-accent-red font-medium'
                            : 'text-text-muted'
                      }`}
                    >
                      {group.title}
                    </span>
                    {group.status === 'running' && (
                      <span className="text-[10.5px] text-accent-blue font-bold uppercase tracking-wider flex-shrink-0">Active</span>
                    )}
                    {group.status === 'incomplete' && (
                      <span className="text-[10.5px] text-text-secondary font-bold uppercase tracking-wider flex-shrink-0">Incomplete</span>
                    )}
                    {group.status === 'error' && (
                      <span className="text-[10.5px] text-accent-red font-bold uppercase tracking-wider flex-shrink-0">Error</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Collapsed bar */}
          {!expanded && (
            <button
              onClick={() => total > 1 && setExpanded(true)}
              className={`w-full flex items-center gap-2.5 px-3.5 py-3 transition-all duration-150 sm:gap-3 sm:px-5 sm:py-3.5 ${total > 1 ? 'hover:bg-bg-secondary cursor-pointer' : 'cursor-default'}`}
              aria-expanded={false}
              aria-label={`Task progress: ${doneCount} of ${total} steps complete`}
            >
              {allDone ? (
                <div className="w-5 h-5 rounded-full bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                  <Check size={11} className="text-text-secondary" strokeWidth={3} />
                </div>
              ) : hasIncomplete && !isStreaming ? (
                <div className="w-5 h-5 rounded-full bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={11} className="text-text-secondary" strokeWidth={2.5} />
                </div>
              ) : (
                <div className="w-5 h-5 rounded-full bg-bg-secondary border border-border-primary flex items-center justify-center flex-shrink-0">
                  <Loader2
                    size={12}
                    className="text-accent-blue flex-shrink-0"
                    style={{ animation: 'spin 1.2s linear infinite' }}
                  />
                </div>
              )}

              <span className="chat-task-title text-text-primary truncate flex-1 text-left font-semibold tracking-[0]">
                {allDone
                  ? taskGroups[taskGroups.length - 1]?.title || 'Done'
                  : hasIncomplete && !isStreaming
                    ? currentDisplayTitle || 'Incomplete'
                  : currentDisplayTitle}
              </span>

              <span className="text-[11.5px] text-text-muted tabular-nums flex-shrink-0 font-semibold bg-bg-secondary border border-border-primary rounded-md px-1.5 py-0.5">
                {doneCount}/{total}
              </span>

              {total > 1 && (
                <ChevronRight
                  size={14}
                  className="text-text-muted flex-shrink-0"
                  strokeWidth={2.25}
                />
              )}
            </button>
          )}

          {/* Collapse button when expanded */}
          {expanded && total > 1 && (
            <button
              onClick={() => setExpanded(false)}
              className="w-full flex items-center justify-center gap-1.5 px-3.5 py-2.5 hover:bg-bg-secondary transition-all duration-150 cursor-pointer border-t border-border-primary sm:px-5"
              aria-expanded={true}
              aria-label="Collapse task progress"
            >
              <ChevronDown size={12} className="text-text-muted" strokeWidth={2.25} />
              <span className="text-[11.5px] text-text-muted font-medium">Collapse</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
