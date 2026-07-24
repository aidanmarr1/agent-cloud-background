'use client'

import { useEffect, useRef, useState } from 'react'

interface MermaidBlockProps {
  code: string
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState<string>('')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncTheme = () => {
      const root = document.documentElement
      setResolvedTheme(
        root.classList.contains('dark') || (!root.classList.contains('light') && media.matches)
          ? 'dark'
          : 'light',
      )
    }

    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    media.addEventListener('change', syncTheme)

    return () => {
      observer.disconnect()
      media.removeEventListener('change', syncTheme)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setSvg('')

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
          securityLevel: 'strict',
        })
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const { svg: renderedSvg } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(renderedSvg)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message || 'Failed to render diagram')
        }
      }
    }

    render()
    return () => { cancelled = true }
  }, [code, resolvedTheme])

  if (error) {
    return (
      <div className="bg-bg-secondary border border-border-primary rounded-2xl p-5">
        <div className="text-[12px] text-accent-red font-semibold mb-2">Failed to render diagram</div>
        <pre className="text-[12px] text-text-secondary font-mono whitespace-pre-wrap leading-relaxed">{code}</pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="bg-bg-secondary border border-border-primary rounded-2xl p-10 flex items-center justify-center">
        <div className="w-4 h-4 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="bg-bg-secondary border border-border-primary rounded-2xl p-5 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
