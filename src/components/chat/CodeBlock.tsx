'use client'

import { useState, useRef, useEffect } from 'react'
import { Copy, Check } from '@/components/icons'

function getTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextContent).join('')
  if (node && typeof node === 'object') {
    const el = node as unknown as { props?: { children?: React.ReactNode; className?: string } }
    if (el.props?.children) return getTextContent(el.props.children)
  }
  return ''
}

function getLanguage(node: React.ReactNode): string | null {
  if (node && typeof node === 'object') {
    const el = node as unknown as { props?: { className?: string; children?: React.ReactNode } }
    if (el.props?.className) {
      const match = el.props.className.match(/language-(\w+)/)
      if (match) return match[1]
    }
  }
  return null
}

export function CodeBlock({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) {
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup timeout on unmount to prevent state update on unmounted component
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const lang = getLanguage(children)

  const handleCopy = async () => {
    const text = getTextContent(children)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      console.warn('[CodeBlock] Clipboard write failed')
    }
  }

  return (
    <div className="relative group/code rounded-2xl border border-border-primary bg-bg-secondary overflow-hidden">
      {lang && (
        <div className="flex items-center justify-between pl-4 pr-2 h-10 border-b border-border-primary">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-text-muted/50" />
            <span className="text-[11.5px] text-text-tertiary font-mono lowercase tabular-nums">{lang}</span>
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 h-7 rounded-md text-[11.5px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
          >
            {copied ? (
              <>
                <Check size={12} className="text-text-secondary" strokeWidth={2.5} />
                <span className="text-text-secondary">Copied</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      )}
      <pre
        className="font-mono text-[13px] leading-relaxed overflow-x-auto px-4 py-3.5"
        {...props}
      >
        {children}
      </pre>
      {!lang && (
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 w-7 h-7 rounded-md bg-bg-secondary backdrop-blur-sm flex items-center justify-center opacity-0 group-hover/code:opacity-100 transition-all duration-150 text-text-muted hover:text-text-primary border border-border-primary"
          aria-label="Copy code"
        >
          {copied ? (
            <Check size={12} className="text-text-secondary" strokeWidth={2.5} />
          ) : (
            <Copy size={12} />
          )}
        </button>
      )}
    </div>
  )
}
