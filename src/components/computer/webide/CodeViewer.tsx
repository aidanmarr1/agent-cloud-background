'use client'

import { useUIStore } from '@/store/ui'
import { useState, useEffect, useCallback, useRef } from 'react'
import { FileCode, Copy, Check } from '@/components/icons'
import hljs from 'highlight.js/lib/core'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import markdown from 'highlight.js/lib/languages/markdown'

hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('markdown', markdown)

const EXT_TO_LANG: Record<string, string> = {
  html: 'html', htm: 'html', css: 'css',
  js: 'javascript', mjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', py: 'python', md: 'markdown',
  svg: 'xml', xml: 'xml',
}

export function CodeViewer() {
  const webIdeConversationId = useUIStore((s) => s.webIdeConversationId)
  const webIdeSelectedFile = useUIStore((s) => s.webIdeSelectedFile)
  const webIdeRefreshKey = useUIStore((s) => s.webIdeRefreshKey)
  const webIdeStreamingFile = useUIStore((s) => s.webIdeStreamingFile)
  const [fetchedContent, setFetchedContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const [displayContent, setDisplayContent] = useState('')
  const lastUpdateRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchSeqRef = useRef(0)

  // Use streaming content if it matches the selected file, otherwise fetch from API
  const isStreaming = webIdeStreamingFile && webIdeSelectedFile === webIdeStreamingFile.path
  const content = isStreaming ? webIdeStreamingFile.content : fetchedContent

  // Throttled display update during streaming (~60ms intervals)
  useEffect(() => {
    if (!content) { setDisplayContent(''); return }
    if (!isStreaming) { setDisplayContent(content); return }

    const now = Date.now()
    const elapsed = now - lastUpdateRef.current
    if (elapsed >= 60) {
      setDisplayContent(content)
      lastUpdateRef.current = now
    } else {
      const timer = setTimeout(() => {
        const latest = useUIStore.getState().webIdeStreamingFile?.content
        if (latest != null) setDisplayContent(latest)
        lastUpdateRef.current = Date.now()
      }, 60 - elapsed)
      return () => clearTimeout(timer)
    }
  }, [content, isStreaming])

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [displayContent, isStreaming])

  const fetchContent = useCallback(async () => {
    if (!webIdeConversationId || !webIdeSelectedFile) return
    // Don't fetch if we already have streaming content for this file
    if (webIdeStreamingFile && webIdeSelectedFile === webIdeStreamingFile.path) return
    const requestSeq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const res = await fetch(`/api/files?conversationId=${webIdeConversationId}&file=${encodeURIComponent(webIdeSelectedFile)}`)
      const data = await res.json()
      if (fetchSeqRef.current === requestSeq) setFetchedContent(data.content ?? null)
    } catch {
      if (fetchSeqRef.current === requestSeq) setFetchedContent(null)
    } finally {
      if (fetchSeqRef.current === requestSeq) setLoading(false)
    }
  }, [webIdeConversationId, webIdeSelectedFile, webIdeStreamingFile])

  useEffect(() => {
    fetchContent()
  }, [fetchContent, webIdeRefreshKey])

  const handleCopy = useCallback(async () => {
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => {
      setCopied(false)
      copyTimerRef.current = null
    }, 2000)
  }, [content])

  useEffect(() => () => {
    fetchSeqRef.current += 1
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  if (!webIdeSelectedFile) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="w-12 h-12 rounded-2xl bg-bg-secondary border border-border-primary flex items-center justify-center mb-4">
          <FileCode size={18} className="text-text-tertiary" strokeWidth={1.75} />
        </div>
        <p className="text-[14px] text-text-primary [font-family:var(--font-display)]">Select a file to view</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-[12px] [font-family:var(--font-display)]">
        Loading…
      </div>
    )
  }

  const fileName = webIdeSelectedFile.split('/').pop() || ''
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const lang = EXT_TO_LANG[ext]

  const renderContent = isStreaming ? displayContent : content
  let highlighted = ''
  if (renderContent !== null && renderContent !== undefined) {
    try {
      if (lang) {
        highlighted = hljs.highlight(renderContent, { language: lang }).value
      } else {
        highlighted = hljs.highlightAuto(renderContent).value
      }
    } catch {
      highlighted = renderContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }

  const lines = renderContent?.split('\n') || []
  const highlightedLines = highlighted.split('\n')

  return (
    <div className="flex flex-col h-full">
      {/* File header */}
      <div className="h-10 px-3 flex items-center gap-2 border-b border-border-primary flex-shrink-0">
        <FileCode size={12} className="text-text-muted" strokeWidth={2.25} />
        <span className="text-[11.5px] text-text-primary font-mono font-semibold truncate flex-1">{fileName}</span>
        {isStreaming && (
          <span className="text-[10px] font-semibold text-accent-blue flex items-center gap-1 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-blue" />
            writing
          </span>
        )}
        <button
          onClick={handleCopy}
          className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check size={11} className="text-text-secondary" strokeWidth={2.5} />
          ) : (
            <Copy size={11} />
          )}
        </button>
      </div>

      {/* Code content */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {content === null ? (
          <div className="p-4 text-[12px] text-text-muted [font-family:var(--font-display)]">Binary file — cannot display</div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((_, i) => (
                <tr key={i} className="hover:bg-bg-secondary">
                  <td className="text-[11px] text-text-muted font-mono text-right pr-3 pl-3 py-0 select-none w-[1%] whitespace-nowrap align-top leading-[20px]">
                    {i + 1}
                  </td>
                  <td className="text-[11px] font-mono pr-3 py-0 align-top leading-[20px]">
                    <span dangerouslySetInnerHTML={{ __html: highlightedLines[i] || '' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
