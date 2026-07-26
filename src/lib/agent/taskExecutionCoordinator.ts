import 'server-only'

import { FatalError } from 'workflow'
import {
  getTaskDispatchConfigurationStatus,
  validateTaskExecutionRunId,
  type TaskDispatchConfigurationStatus,
} from '@/lib/agent/taskDispatch'

export interface TaskExecutionCoordinatorStatus extends TaskDispatchConfigurationStatus {
  workflowConfigured: boolean
}

export interface StartedTaskExecutionCoordinator {
  taskRunId: string
  workflowRunId: string
}

export function getTaskExecutionCoordinatorStatus(): TaskExecutionCoordinatorStatus {
  return {
    ...getTaskDispatchConfigurationStatus(),
    workflowConfigured: true,
  }
}

export async function startTaskExecutionCoordinator(
  runId: string,
): Promise<StartedTaskExecutionCoordinator> {
  const taskRunId = validateTaskExecutionRunId(runId)
  const status = getTaskExecutionCoordinatorStatus()
  if (!status.configured) {
    throw new FatalError('On-demand task execution is not configured.')
  }

  // Load the workflow entry only when starting a run so ordinary readiness
  // checks do not initialize the Workflow SDK's start path.
  const [{ start }, { taskExecutionWorkflow }] = await Promise.all([
    import('workflow/api'),
    import('@/workflows/taskExecution'),
  ])
  const workflowRun = await start(taskExecutionWorkflow, [taskRunId])
  return {
    taskRunId,
    workflowRunId: workflowRun.runId,
  }
}
