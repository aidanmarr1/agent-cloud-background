'use client'

import { TerminalResult } from '@/types'
import { useState, useEffect, useRef } from 'react'
import { Check, Copy } from '@/components/icons'
import { parseAnsi } from '@/lib/parseAnsi'

interface TerminalViewProps {
  result: TerminalResult
  streaming?: boolean
}

export function TerminalView({ result, streaming = false }: TerminalViewProps) {
  const [copied, setCopied] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  const handleCopy = () => {
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (streaming && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [streaming, result.stdout, result.stderr])

  return (
    <div className="p-4 flex flex-col gap-3">
      {/* Command bar */}
      <div className="rounded-2xl border border-border-primary bg-bg-secondary overflow-hidden">
        <div className="h-11 px-4 flex items-center gap-2.5">
          <span className="text-text-secondary text-[12.5px] font-mono font-bold flex-shrink-0">$</span>
          <span className="text-[12.5px] text-text-primary font-mono truncate flex-1">
            {result.command || (streaming ? 'Running…' : '')}
          </span>
          {!streaming && (
            <button
              onClick={handleCopy}
              className="w-7 h-7 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150 flex-shrink-0"
              aria-label="Copy command output"
            >
              {copied ? <Check size={12} className="text-text-secondary" strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2.25} />}
            </button>
          )}
        </div>
      </div>

      {/* Stdout */}
      {(result.stdout || streaming) && (
        <div ref={outputRef} className="bg-bg-primary rounded-2xl px-4 py-3.5 overflow-y-auto border border-border-primary">
          <pre className="text-[11.5px] text-text-secondary font-mono whitespace-pre-wrap break-words leading-relaxed">
            {result.stdout ? parseAnsi(result.stdout).map((segment, i) => (
              <span key={i} className={segment.className}>{segment.text}</span>
            )) : ''}
            {streaming && <span className="inline-block w-1.5 h-3 bg-text-muted animate-pulse ml-0.5 align-middle" />}
          </pre>
        </div>
      )}

      {/* Stderr */}
      {result.stderr && (
        <div className="bg-accent-red/5 rounded-2xl px-4 py-3.5 max-h-[200px] overflow-y-auto border border-accent-red/15">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-red/70" />
            <span className="text-[10.5px] text-accent-red/80 font-semibold uppercase tracking-wider">Needs attention</span>
          </div>
          <pre className="text-[11.5px] text-accent-red/80 font-mono whitespace-pre-wrap break-words leading-relaxed">
            {result.stderr}
          </pre>
        </div>
      )}

      {/* No output (only when not streaming) */}
      {!result.stdout && !result.stderr && !streaming && (
        <div className="bg-bg-primary rounded-2xl px-4 py-3.5 border border-border-primary">
          <span className="text-[12px] text-text-muted [font-family:var(--font-display)]">No output</span>
        </div>
      )}

      {/* Status bar */}
      {!streaming ? (
        <div className="flex items-center gap-2 px-1.5">
          <span
            className={`flex items-center gap-1.5 text-[11px] font-semibold font-mono ${
              result.exitCode === 0 ? 'text-text-secondary' : 'text-accent-red'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${result.exitCode === 0 ? 'bg-text-secondary' : 'bg-accent-red'}`} />
            {result.exitCode === 0 ? 'completed' : 'stopped'}
          </span>
          <span className="text-text-muted/40">·</span>
          <span className="text-[11px] text-text-muted tabular-nums font-medium">
            {(result.durationMs / 1000).toFixed(1)}s
          </span>
          {result.timedOut && (
            <>
              <span className="text-text-muted/40">·</span>
              <span className="text-[11px] font-semibold text-text-secondary">
                took too long
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 px-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-status-live text-status-live animate-live-pulse" />
          <span className="text-[11px] font-semibold text-accent-blue">running</span>
        </div>
      )}
    </div>
  )
}
