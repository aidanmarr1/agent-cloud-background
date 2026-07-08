import { v4 as uuidv4 } from 'uuid'
import type { TaskStep, TaskGroup, Subtask, StepItem, StepAction } from '@/types'
import type { SliceCreator } from './types'
import { updateLastAssistantMessage, truncateResult } from './persistence'

export interface TaskSlice {
  // Legacy step actions (backward compat)
  setSteps: (convId: string, steps: TaskStep[]) => void
  updateStepStatus: (convId: string, index: number, status: TaskStep['status'], title?: string) => void
  addStepItem: (convId: string, stepIndex: number, item: StepItem) => void
  appendToStepUpdate: (convId: string, stepIndex: number, text: string) => void
  updateLastActionResult: (convId: string, stepIndex: number, result: StepAction['result']) => void

  // TaskGroup actions
  setTaskGroups: (convId: string, groups: TaskGroup[]) => void
  updateTaskGroupStatus: (convId: string, groupIndex: number, status: TaskGroup['status']) => void
  addSubtaskToGroup: (convId: string, groupIndex: number, subtask: Subtask) => void
  updateSubtaskInGroup: (convId: string, groupIndex: number, subtaskId: string, status: Subtask['status'], result?: Subtask['result'], patch?: Partial<Subtask>) => void
  addGroupNarration: (convId: string, groupIndex: number, text: string, position?: number) => void
  setPlan: (convId: string, items: string[]) => void
}

function taskGroups(value: TaskGroup[] | null | undefined): TaskGroup[] {
  return Array.isArray(value) ? value : []
}

function taskSubtasks(group: Pick<TaskGroup, 'subtasks'>): Subtask[] {
  return Array.isArray(group.subtasks) ? group.subtasks : []
}

function taskNarrations(group: Pick<TaskGroup, 'narrations'>): TaskGroup['narrations'] {
  return Array.isArray(group.narrations) ? group.narrations : []
}

export const createTaskSlice: SliceCreator<TaskSlice> = (set) => ({
  // Legacy step actions
  setSteps: (convId, steps) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => ({
        ...msg,
        steps: [...steps],
      })),
    }))
  },

  updateStepStatus: (convId, index, status, title?) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const steps = (msg.steps || []).map((s) =>
          s.index === index
            ? {
                ...s,
                status,
                ...(title ? { title } : {}),
                ...(status === 'running' && !s.startedAt ? { startedAt: Date.now() } : {}),
              }
            : s
        )
        return { ...msg, steps }
      }),
    }))
  },

  addStepItem: (convId, stepIndex, item) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const steps = (msg.steps || []).map((s) =>
          s.index === stepIndex
            ? { ...s, items: [...(s.items || []), item] }
            : s
        )
        return { ...msg, steps }
      }),
    }))
  },

  appendToStepUpdate: (convId, stepIndex, text) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const steps = (msg.steps || []).map((s) => {
          if (s.index !== stepIndex) return s
          const items = [...(s.items || [])]
          const last = items[items.length - 1]
          if (last && last.type === 'update') {
            items[items.length - 1] = { ...last, content: last.content + text }
          } else {
            items.push({ type: 'update', content: text })
          }
          return { ...s, items }
        })
        return { ...msg, steps }
      }),
    }))
  },

  updateLastActionResult: (convId, stepIndex, result) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const steps = (msg.steps || []).map((s) => {
          if (s.index !== stepIndex) return s
          const items = [...(s.items || [])]
          for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].type !== 'update') {
              items[i] = { ...items[i], result } as StepItem
              break
            }
          }
          return { ...s, items }
        })
        return { ...msg, steps }
      }),
    }))
  },

  // TaskGroup actions
  setTaskGroups: (convId, groups) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => ({
        ...msg,
        taskGroups: taskGroups(groups),
      })),
    }))
  },

  updateTaskGroupStatus: (convId, groupIndex, status) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const groups = taskGroups(msg.taskGroups).map((g, i) =>
          i === groupIndex
            ? {
                ...g,
                status,
                ...(status === 'running' && !g.startedAt ? { startedAt: Date.now() } : {}),
              }
            : g
        )
        return { ...msg, taskGroups: groups }
      }),
    }))
  },

  addSubtaskToGroup: (convId, groupIndex, subtask) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const groups = taskGroups(msg.taskGroups).map((g, i) =>
          i === groupIndex
            ? { ...g, subtasks: [...taskSubtasks(g), subtask] }
            : g
        )
        return { ...msg, taskGroups: groups }
      }),
    }))
  },

  updateSubtaskInGroup: (convId, groupIndex, subtaskId, status, result, patch) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const groups = taskGroups(msg.taskGroups).map((g, i) =>
          i === groupIndex
            ? {
                ...g,
                subtasks: taskSubtasks(g).map((s) =>
                  s.id === subtaskId
                    ? { ...s, ...(patch || {}), status, ...(result !== undefined ? { result: truncateResult(result) as Subtask['result'] } : {}) }
                    : s
                ),
              }
            : g
        )
        return { ...msg, taskGroups: groups }
      }),
    }))
  },

  addGroupNarration: (convId, groupIndex, text, position) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const groups = taskGroups(msg.taskGroups).map((g, i) =>
          i === groupIndex
            ? (() => {
                const subtasks = taskSubtasks(g)
                const narrations = taskNarrations(g)
                const narrationPosition = Math.max(0, Math.min(subtasks.length, position ?? subtasks.length))
                return {
                  ...g,
                  subtasks,
                  narrations: narrations.some(narration => narration.position === narrationPosition)
                    ? narrations
                    : [
                        ...narrations,
                        { id: uuidv4(), text, position: narrationPosition },
                      ],
                }
              })()
            : g
        )
        return { ...msg, taskGroups: groups }
      }),
    }))
  },

  setPlan: (convId, items) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => ({
        ...msg,
        plan: items,
      })),
    }))
  },
})
