const SAFE_QUEUE_NAME = /^[a-zA-Z0-9_.:-]{1,128}$/
export const TASK_ORCHESTRATION_PROTOCOL_VERSION = '3'
const TASK_ORCHESTRATION_QUEUE_SUFFIX = `:orchestration-v${TASK_ORCHESTRATION_PROTOCOL_VERSION}`

export function taskQueueName(): string {
  const raw = process.env.AGENT_TASK_QUEUE_NAME?.trim() || 'default'
  if (!SAFE_QUEUE_NAME.test(raw)) {
    throw new Error('Invalid AGENT_TASK_QUEUE_NAME: use 1-128 letters, numbers, dots, colons, underscores, or hyphens')
  }
  const versioned = `${raw}${TASK_ORCHESTRATION_QUEUE_SUFFIX}`
  if (versioned.length > 128) {
    throw new Error('AGENT_TASK_QUEUE_NAME is too long after adding the orchestration protocol suffix')
  }
  return versioned
}
