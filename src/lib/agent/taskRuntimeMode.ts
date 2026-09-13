export const E2B_DISPATCH_BACKEND = 'e2b-task-runtime'

export function usesE2BTaskRuntime(): boolean {
  return process.env.AGENT_TASK_DISPATCH_MODE?.trim() === 'e2b_job'
}

export function taskDispatchBackend(): 'render-one-off' | typeof E2B_DISPATCH_BACKEND {
  return usesE2BTaskRuntime() ? E2B_DISPATCH_BACKEND : 'render-one-off'
}
