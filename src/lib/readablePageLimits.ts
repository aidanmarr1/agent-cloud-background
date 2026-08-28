export const MAX_READABLE_PAGE_CHARS = 40_000

export function truncateReadablePageContent(content: string): string {
  if (content.length <= MAX_READABLE_PAGE_CHARS) return content

  const originalLength = content.length
  const paragraphBreak = content.lastIndexOf('\n\n', MAX_READABLE_PAGE_CHARS - 120)
  if (paragraphBreak > MAX_READABLE_PAGE_CHARS * 0.7) {
    return content.slice(0, paragraphBreak) + `\n\n... [Truncated from ${originalLength} characters]`
  }

  const sentenceBreak = content.lastIndexOf('. ', MAX_READABLE_PAGE_CHARS - 80)
  if (sentenceBreak > MAX_READABLE_PAGE_CHARS * 0.75) {
    return content.slice(0, sentenceBreak + 1) + `\n\n... [Truncated from ${originalLength} characters]`
  }

  return content.slice(0, MAX_READABLE_PAGE_CHARS) + `\n\n... [Truncated from ${originalLength} characters]`
}
