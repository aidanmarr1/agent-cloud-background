export type FollowUpCategory = 'detail' | 'code' | 'compare' | 'example' | 'default'

export function categorizeFollowUp(text: string): FollowUpCategory {
  const lower = text.toLowerCase()
  if (lower.includes('more') || lower.includes('detail') || lower.includes('elaborate') || lower.includes('deeper')) return 'detail'
  if (lower.includes('code') || lower.includes('build') || lower.includes('implement') || lower.includes('write')) return 'code'
  if (lower.includes('compare') || lower.includes('vs') || lower.includes('difference') || lower.includes('versus')) return 'compare'
  if (lower.includes('example') || lower.includes('show me') || lower.includes('demonstrate')) return 'example'
  return 'default'
}
