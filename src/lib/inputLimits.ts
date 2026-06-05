export const MAX_TASK_INPUT_CHARS = 1000

export function clampTaskInput(value: string): string {
  return value.length > MAX_TASK_INPUT_CHARS ? value.slice(0, MAX_TASK_INPUT_CHARS) : value
}

export function taskInputLimitMessage(): string {
  return `Messages are limited to ${MAX_TASK_INPUT_CHARS.toLocaleString()} characters.`
}
