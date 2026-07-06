'use client'

import { memo } from 'react'
import { Loader2, Check, Search, Globe, Terminal, FilePlus, FileText, Trash2, FolderOpen, Monitor, Edit3, BookOpen, AlertTriangle } from '@/components/icons'
import { TaskGroup, Subtask, GroupNarration } from '@/types'
import { sanitizeNarrationText } from '@/lib/stream/cleaners'
import { isHiddenSubtaskActivity } from '@/lib/stream/constants'
import { formatVisibleActionLabel } from '@/lib/stream/ActivityDescriber'

interface ActionFeedProps {
  taskGroups: TaskGroup[]
}

const iconMap: Record<string, React.ReactNode> = {
  search: <Search size={13} className="flex-shrink-0" />,
  browse: <Globe size={13} className="flex-shrink-0" />,
  terminal: <Terminal size={13} className="flex-shrink-0" />,
  create_file: <FilePlus size={13} className="flex-shrink-0" />,
  read_file: <FileText size={13} className="flex-shrink-0" />,
  read_skill: <BookOpen size={13} className="flex-shrink-0" />,
  delete_file: <Trash2 size={13} className="flex-shrink-0" />,
  list_files: <FolderOpen size={13} className="flex-shrink-0" />,
  append_file: <Edit3 size={13} className="flex-shrink-0" />,
  export_pdf: <FileText size={13} className="flex-shrink-0" />,
  browser: <Monitor size={13} className="flex-shrink-0" />,
}

function getActionLabel(subtask: Subtask): string {
  return formatVisibleActionLabel(subtask.label || '')
}

const ActionPill = memo(function ActionPill({ subtask }: { subtask: Subtask }) {
  const isRunning = subtask.status === 'running'
  const icon = iconMap[subtask.type] || <Globe size={13} className="flex-shrink-0" />
  const label = getActionLabel(subtask)
  if (!label) return null

  return (
    <div className="inline-flex items-center gap-2 rounded-lg bg-bg-secondary border border-border-primary px-3 h-8 max-w-full overflow-hidden cursor-default">
      <span className="text-text-tertiary flex-shrink-0">{icon}</span>
      <span className={`text-[12.5px] font-medium truncate ${isRunning ? 'text-text-primary' : 'text-text-secondary'}`}>
        {label}
      </span>
      {isRunning && (
        <Loader2
          size={11}
          className="text-text-tertiary flex-shrink-0"
          style={{ animation: 'spin 1.5s linear infinite' }}
        />
      )}
    </div>
  )
})

export function ActionFeed({ taskGroups }: ActionFeedProps) {
  if (taskGroups.length === 0) return null

  return (
    <div className="space-y-3">
      {taskGroups.map((group) => {
        const visibleSubtasks = group.subtasks.filter(s => !isHiddenSubtaskActivity(s) && getActionLabel(s))
        const doneCount = visibleSubtasks.filter(s => s.status === 'done').length

        return (
          <div key={group.id} className="animate-fade-in">
            {/* Group header */}
            <div className="flex items-center gap-3 mb-3">
              {group.status === 'done' ? (
                <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
                  <Check size={11} className="text-text-secondary" strokeWidth={3} />
                </div>
              ) : group.status === 'incomplete' ? (
                <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={11} className="text-text-secondary" strokeWidth={2.5} />
                </div>
              ) : group.status === 'error' ? (
                <div className="w-5 h-5 rounded-full bg-accent-red/10 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={11} className="text-accent-red" strokeWidth={2.5} />
                </div>
              ) : (
                <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
                  <Loader2
                    size={11}
                    className="text-accent-blue flex-shrink-0"
                    style={{ animation: 'spin 1.2s linear infinite' }}
                  />
                </div>
              )}
              <span className="text-[14px] font-semibold text-text-primary truncate flex-1 tracking-[0]">
                {group.title}
              </span>
              {visibleSubtasks.length > 0 && (
                <span className="text-[11.5px] text-text-muted tabular-nums font-medium">
                  {doneCount} / {visibleSubtasks.length}
                </span>
              )}
            </div>

            {/* Pills + narrations */}
            <div className="pl-7">
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
                      <div key={idx} className="flex flex-col items-start gap-1.5 mb-2">
                        {cluster.items.map((subtask) => (
                          <ActionPill key={subtask.id} subtask={subtask} />
                        ))}
                      </div>
                    )
                  }

                  const narrationText = sanitizeNarrationText(cluster.data.text)
                  if (!narrationText) return null

                  return (
                    <p key={cluster.data.id} className="text-[13px] text-text-secondary leading-relaxed mb-2">
                      {narrationText}
                    </p>
                  )
                })
              })()}

              {group.synthesis && (
                <p className="text-[13px] text-text-secondary leading-relaxed">
                  {group.synthesis}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
