export function highlightText(text: string, query: string): Array<{ text: string; highlighted: boolean }> {
  if (!query.trim()) return [{ text, highlighted: false }]

  const parts: Array<{ text: string; highlighted: boolean }> = []
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  let lastIndex = 0
  let index = lowerText.indexOf(lowerQuery, lastIndex)

  while (index !== -1) {
    if (index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, index), highlighted: false })
    }
    parts.push({ text: text.slice(index, index + query.length), highlighted: true })
    lastIndex = index + query.length
    index = lowerText.indexOf(lowerQuery, lastIndex)
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), highlighted: false })
  }

  return parts.length > 0 ? parts : [{ text, highlighted: false }]
}
