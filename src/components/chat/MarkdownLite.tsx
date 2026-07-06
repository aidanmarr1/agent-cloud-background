'use client'

import type { ReactNode } from 'react'
import { normalizeMarkdownForDisplay } from '@/lib/stream/cleaners'
import { CodeBlock } from './CodeBlock'
import { CollapsibleCodeBlock } from './CollapsibleCodeBlock'
import { EnhancedTable, EnhancedThead } from './EnhancedTable'

interface MarkdownLiteProps {
  children?: string
  className?: string
}

function safeLinkHref(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('//')) return null
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

function safeImageSrc(src: string): string | null {
  const trimmed = src.trim()
  if (!trimmed || trimmed.startsWith('//')) return null
  if (trimmed.startsWith('/')) return trimmed
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function isExternalHttpUrl(href: string): boolean {
  try {
    const parsed = new URL(href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(!\[([^\]]*)\]\(([^)\s]+)\)|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const key = `${keyPrefix}-${match.index}`

    if (match[2] !== undefined) {
      const src = safeImageSrc(match[3])
      nodes.push(src ? <img key={key} src={src} alt={match[2]} /> : match[0])
    } else if (match[4] !== undefined) {
      nodes.push(<code key={key}>{match[4]}</code>)
    } else if (match[5] !== undefined) {
      const href = safeLinkHref(match[6])
      const external = href ? isExternalHttpUrl(href) : false
      nodes.push(href ? (
        <a
          key={key}
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer' : undefined}
        >
          {renderInline(match[5], `${key}-link`)}
        </a>
      ) : match[0])
    } else {
      const strong = match[7] ?? match[8]
      const emphasis = match[9] ?? match[10]
      if (strong !== undefined) {
        nodes.push(<strong key={key}>{renderInline(strong, `${key}-strong`)}</strong>)
      } else if (emphasis !== undefined) {
        nodes.push(<em key={key}>{renderInline(emphasis, `${key}-em`)}</em>)
      }
    }

    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isBlockStart(line: string, nextLine?: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('```')) return true
  if (/^#{1,6}\s+/.test(trimmed)) return true
  if (/^([-*_])\1\1+$/.test(trimmed)) return true
  if (/^>\s?/.test(trimmed)) return true
  if (/^\s*[-*]\s+/.test(line)) return true
  if (/^\s*\d+[.)]\s+/.test(line)) return true
  if (trimmed.includes('|') && nextLine && isTableSeparator(nextLine)) return true
  return false
}

function renderHeading(level: number, content: string, key: string): ReactNode {
  const children = renderInline(content, key)
  if (level === 1) return <h1 key={key}>{children}</h1>
  if (level === 2) return <h2 key={key}>{children}</h2>
  if (level === 3) return <h3 key={key}>{children}</h3>
  if (level === 4) return <h4 key={key}>{children}</h4>
  if (level === 5) return <h5 key={key}>{children}</h5>
  return <h6 key={key}>{children}</h6>
}

function renderMarkdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const nodes: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    const key = `md-${i}`

    if (!trimmed) {
      i++
      continue
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?/)
    if (fence) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++

      const code = codeLines.join('\n')
      const lineCount = codeLines.length
      const language = fence[1]
      const codeNode = <code className={language ? `language-${language}` : undefined}>{code}</code>
      nodes.push(
        lineCount > 50
          ? <CollapsibleCodeBlock key={key} lineCount={lineCount}>{codeNode}</CollapsibleCodeBlock>
          : <CodeBlock key={key}>{codeNode}</CodeBlock>
      )
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      nodes.push(renderHeading(heading[1].length, heading[2], key))
      i++
      continue
    }

    if (/^([-*_])\1\1+$/.test(trimmed)) {
      nodes.push(<hr key={key} />)
      i++
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      nodes.push(<blockquote key={key}>{renderInline(quoteLines.join(' '), key)}</blockquote>)
      continue
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/)
    if (unordered) {
      const items: ReactNode[] = []
      while (i < lines.length) {
        const item = lines[i].match(/^\s*[-*]\s+(.+)$/)
        if (!item) break
        items.push(<li key={`${key}-${i}`}>{renderInline(item[1], `${key}-${i}`)}</li>)
        i++
      }
      nodes.push(<ul key={key}>{items}</ul>)
      continue
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (ordered) {
      const items: ReactNode[] = []
      while (i < lines.length) {
        const item = lines[i].match(/^\s*\d+[.)]\s+(.+)$/)
        if (!item) break
        items.push(<li key={`${key}-${i}`}>{renderInline(item[1], `${key}-${i}`)}</li>)
        i++
      }
      nodes.push(<ol key={key}>{items}</ol>)
      continue
    }

    if (trimmed.includes('|') && lines[i + 1] && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(splitTableRow(lines[i]))
        i++
      }

      nodes.push(
        <EnhancedTable key={key}>
          <EnhancedThead>
            <tr>
              {headers.map((header, column) => (
                <th key={column}>{renderInline(header, `${key}-h-${column}`)}</th>
              ))}
            </tr>
          </EnhancedThead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {headers.map((_, column) => (
                  <td key={column}>{renderInline(row[column] ?? '', `${key}-${rowIndex}-${column}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </EnhancedTable>
      )
      continue
    }

    const paragraphLines: string[] = [trimmed]
    i++
    while (i < lines.length && !isBlockStart(lines[i], lines[i + 1])) {
      paragraphLines.push(lines[i].trim())
      i++
    }
    nodes.push(<p key={key}>{renderInline(paragraphLines.join(' '), key)}</p>)
  }

  return nodes
}

export function MarkdownLite({ children = '', className }: MarkdownLiteProps) {
  const content = renderMarkdownBlocks(normalizeMarkdownForDisplay(children))
  if (className) return <div className={className}>{content}</div>
  return <>{content}</>
}
