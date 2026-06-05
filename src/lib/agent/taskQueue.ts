const SAFE_QUEUE_NAME = /^[a-zA-Z0-9_.:-]{1,128}$/

export function taskQueueName(): string {
  const raw = process.env.AGENT_TASK_QUEUE_NAME?.trim() || 'default'
  if (!SAFE_QUEUE_NAME.test(raw)) {
    throw new Error('Invalid AGENT_TASK_QUEUE_NAME: use 1-128 letters, numbers, dots, colons, underscores, or hyphens')
  }
  return raw
}
