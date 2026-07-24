'use client'

import { TaskGroup } from '@/types'
import { TaskGroupView } from './TaskGroupView'

interface ActionFeedProps {
  taskGroups: TaskGroup[]
}

export function ActionFeed({ taskGroups }: ActionFeedProps) {
  const orderedGroups = taskGroups
    .filter((group) => group.status !== 'pending')
    .sort((a, b) => a.index - b.index)
  const currentRunningGroupId = [...orderedGroups]
    .reverse()
    .find((group) => group.status === 'running')?.id
  if (orderedGroups.length === 0) return null
  return (
    <section
      className="overflow-hidden"
      aria-label="Task activity"
    >
      <div className="space-y-0.5">
        {orderedGroups.map((group) => (
          <TaskGroupView
            key={group.id}
            group={group}
            isCurrentGroup={group.id === currentRunningGroupId}
          />
        ))}
      </div>
    </section>
  )
}
