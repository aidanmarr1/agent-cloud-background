'use client'

import { useEffect, useState } from 'react'
import { Check, Globe, ChevronRight, Search, ImageSearch, Terminal, FilePlus, FileText, FileCode, Code, Edit3, Loader2, X, AlertTriangle, FolderOpen, BookOpen, Link, Trash2 } from '@/components/icons'
import { TaskGroup } from '@/types'
import { isHiddenSubtaskActivity } from '@/lib/stream/constants'
import { sanitizeNarrationText } from '@/lib/stream/cleaners'
import { formatVisibleActionLabel } from '@/lib/stream/ActivityDescriber'
import { MarkdownLite } from './MarkdownLite'

interface CompletionBannerProps {
  completedSteps: number
  totalSteps: number
  elapsedMs?: number
  sourceCount?: number
  taskGroups?: TaskGroup[]
}

const iconMap: Record<string, React.ReactNode> = {
  search: <Search size={12} />,
  image_search: <ImageSearch size={13} />,
  terminal: <Terminal size={12} />,
  browse: <Globe size={12} />,
  create_file: <FilePlus size={12} />,
  read_file: <FileText size={12} />,
  read_skill: <BookOpen size={12} />,
  list_files: <FolderOpen size={12} />,
  delete_file: <Trash2 size={12} />,
  edit_file: <Edit3 size={12} />,
  append_file: <Edit3 size={12} />,
  export_pdf: <FileText size={12} />,
  run_code: <Code size={12} />,
  browser: <Globe size={12} />,
  http_request: <Link size={12} />,
  read_document: <FileCode size={12} />,
}

function formatElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function TimelineModal({ taskGroups, elapsedMs, completedSteps, totalSteps, sourceCount, onClose }: {
  taskGroups: TaskGroup[]
  elapsedMs?: number
  completedSteps: number
  totalSteps: number
  sourceCount?: number
  onClose: () => void
}) {
  const toolCount = taskGroups.reduce((total, group) => {
    const subtasks = Array.isArray(group.subtasks) ? group.subtasks : []
    return total + subtasks.filter((subtask) => (
      !isHiddenSubtaskActivity(subtask) && Boolean(formatVisibleActionLabel(subtask.label || ''))
    )).length
  }, 0)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center animate-fade-in sm:items-center sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close task details"
      />
      <section
        className="relative flex max-h-[86dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border-primary bg-bg-primary animate-scale-in sm:max-w-lg sm:rounded-2xl"
        style={{ boxShadow: 'var(--shadow-xl)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-details-title"
      >
        <header className="flex min-h-14 flex-shrink-0 items-center justify-between border-b border-border-primary px-4 sm:px-5">
          <div className="min-w-0">
            <h3 id="task-details-title" className="text-[15px] font-semibold tracking-[0] text-text-primary [font-family:var(--font-display)]">Work details</h3>
            <p className="mt-0.5 text-[10.5px] text-text-muted">A compact record of how this result was produced</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors duration-150 hover:bg-bg-secondary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={14} strokeWidth={2.25} />
          </button>
        </header>

        <div className="flex-1 space-y-2 overflow-y-auto p-2.5 sm:p-3">
          {taskGroups.map((group) => {
            const subtasks = (Array.isArray(group.subtasks) ? group.subtasks : []).filter((subtask) => (
              !isHiddenSubtaskActivity(subtask) && Boolean(formatVisibleActionLabel(subtask.label || ''))
            ))
            const narrationNotes = (Array.isArray(group.narrations) ? group.narrations : [])
              .map((narration) => ({ ...narration, text: sanitizeNarrationText(narration.text) }))
              .filter((narration) => Boolean(narration.text))
            const synthesis = sanitizeNarrationText(group.synthesis || '')
            const hasNotes = narrationNotes.length > 0 || Boolean(synthesis)

            return (
              <div key={group.id} className="border-b border-border-secondary last:border-b-0">
                <div className="flex min-h-11 items-center gap-2.5 px-2">
                  {group.status === 'done' ? (
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-bg-secondary">
                      <Check size={10} className="text-text-tertiary" strokeWidth={3} />
                    </span>
                  ) : group.status === 'error' || group.status === 'incomplete' ? (
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-danger-bg">
                      <AlertTriangle size={10} className="text-danger-icon" />
                    </span>
                  ) : (
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-bg-secondary">
                      <Loader2 size={10} className="text-accent-blue" style={{ animation: 'spin 1.4s linear infinite' }} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-text-primary">{group.title}</span>
                  <span className="flex-shrink-0 text-[10px] font-medium tabular-nums text-text-muted">
                    {subtasks.length} {subtasks.length === 1 ? 'action' : 'actions'}
                  </span>
                </div>

                {subtasks.length > 0 ? (
                  <div className="task-thread-body relative ml-[9px] pb-2 pl-5 pr-1">
                    {subtasks.map((subtask) => {
                      const label = formatVisibleActionLabel(subtask.label || '')
                      const icon = iconMap[subtask.type] || <Globe size={12} />
                      return (
                        <div key={subtask.id} className="flex min-h-8 items-center gap-2.5 px-1 py-1.5">
                          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                            {subtask.status === 'done' ? (
                              <Check size={10} className="text-text-muted" strokeWidth={3} />
                            ) : subtask.status === 'error' ? (
                              <AlertTriangle size={10} className="text-danger-icon" />
                            ) : (
                              <Loader2 size={10} className="text-accent-blue" style={{ animation: 'spin 1.4s linear infinite' }} />
                            )}
                          </span>
                          <span className="flex-shrink-0 text-text-muted">{icon}</span>
                          <span className={`min-w-0 flex-1 truncate text-[12px] ${subtask.status === 'error' ? 'text-danger-text' : 'text-text-tertiary'}`}>
                            {label}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : !hasNotes ? (
                  <p className="ml-[9px] border-l border-border-secondary px-5 py-2 text-[11.5px] text-text-muted">No tool activity was recorded for this step.</p>
                ) : null}

                {hasNotes && (
                  <details className="ml-[9px] border-l border-border-secondary">
                    <summary className="cursor-pointer select-none px-5 py-2 text-[10.5px] font-medium text-text-muted transition-colors hover:text-text-secondary">
                      View progress notes
                    </summary>
                    <div className="space-y-2 px-5 py-2.5">
                      {narrationNotes.map((note) => (
                        <div key={note.id} className="markdown-content text-[11.5px] leading-relaxed text-text-tertiary">
                          <MarkdownLite>{note.text || ''}</MarkdownLite>
                        </div>
                      ))}
                      {synthesis && (
                        <div className="markdown-content text-[11.5px] leading-relaxed text-text-secondary">
                          <MarkdownLite>{synthesis}</MarkdownLite>
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            )
          })}
        </div>

        <footer className="flex min-h-11 flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-primary px-4 py-2 text-[10.5px] tabular-nums text-text-muted sm:px-5">
          <span className="font-semibold text-text-tertiary">{toolCount} {toolCount === 1 ? 'action' : 'actions'}</span>
          {totalSteps > 0 && <span>{completedSteps}/{totalSteps} steps</span>}
          {elapsedMs !== undefined && elapsedMs > 1000 && <span>{formatElapsed(elapsedMs)}</span>}
          {sourceCount !== undefined && sourceCount > 0 && <span>{sourceCount} sources</span>}
        </footer>
      </section>
    </div>
  )
}

export function CompletionBanner({ completedSteps, totalSteps, elapsedMs, sourceCount, taskGroups }: CompletionBannerProps) {
  const [showTimeline, setShowTimeline] = useState(false)

  return (
    <>
      <div className="mt-5 flex min-h-9 items-center gap-2 border-t border-border-secondary pt-3 animate-fade-in">
        <Check size={13} className="flex-shrink-0 text-success-icon" strokeWidth={2.5} aria-hidden="true" />
        <span className="text-[11.5px] font-medium text-success-text">Task completed</span>
        {taskGroups && taskGroups.length > 0 && (
          <>
            <span className="mx-1 h-4 w-px bg-border-primary" aria-hidden="true" />
            <button
              type="button"
              onClick={() => setShowTimeline(true)}
              aria-label="Show work details"
              className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium text-text-muted transition-colors duration-100 hover:bg-bg-secondary hover:text-text-primary"
            >
              Details
              <ChevronRight size={10} />
            </button>
          </>
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
