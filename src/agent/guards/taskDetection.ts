export const BUILD_KEYWORDS = /\b(build|create|make|design|code|develop|generate|write)\b.*\b(website|webpage|web\s*page|site|landing\s*page|app|application|portfolio|dashboard|page|frontend|ui|component|widget|form|layout|template)/i

export const RESEARCH_KEYWORDS = /\b(research|find\s*out|investigate|compare|analyze|what\s*(?:is|are|was|were)|how\s*(?:does|do|did)|explain|summarize|report\s*on|deep\s*dive)\b/i

export const CODE_KEYWORDS = /\b(write\s*(?:a|me|the)?\s*(?:function|class|script|program|module|test|code)|implement|debug|fix\s*(?:this|the)\s*bug|refactor|algorithm|solve|code\s*(?:a|the|this))\b/i

export const ANALYSIS_KEYWORDS = /\b(chart|graph|plot|visualize|data\s*analysis|spreadsheet|csv|statistics|trend|correlation|regression|dashboard)\b/i

export type TaskType = 'build' | 'research' | 'code' | 'analysis' | 'browse' | 'general'

export function detectTaskType(messages: Array<{ role: string; content: string }>): TaskType {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  const content = lastUserMsg?.content || ''

  if (BUILD_KEYWORDS.test(content)) return 'build'
  if (CODE_KEYWORDS.test(content)) return 'code'
  if (ANALYSIS_KEYWORDS.test(content)) return 'analysis'
  if (RESEARCH_KEYWORDS.test(content)) return 'research'
  if (/\b(go\s*to|navigate|click|log\s*in|sign\s*in|fill\s*out|browse)\b/i.test(content)) return 'browse'
  return 'general'
}

export function isBuildTask(messages: Array<{ role: string; content: string }>): boolean {
  const taskType = detectTaskType(messages)
  return taskType === 'build' || taskType === 'code'
}
