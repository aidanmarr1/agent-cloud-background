'use client'

import { useEffect, useRef, useState } from 'react'

interface MermaidBlockProps {
  code: string
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState<string>('')

  useEffect(() => {
    let cancelled = false

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
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
  }, [code])

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
