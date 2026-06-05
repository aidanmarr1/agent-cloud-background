'use client'

import { useState, useEffect } from 'react'
import { ChevronUp, Check, Loader2, Circle, AlertTriangle } from '@/components/icons'
import { TaskStep as TaskStepType, StepItem } from '@/types'
import { ActionPill } from './ActionPill'

interface TaskStepProps {
  step: TaskStepType
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

export function TaskStep({ step }: TaskStepProps) {
  const [expanded, setExpanded] = useState(step.status === 'running')
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (step.status === 'running') setExpanded(true)
  }, [step.status])

  useEffect(() => {
    if (step.status === 'running' && step.startedAt) {
      const interval = setInterval(() => {
        setElapsed(Date.now() - step.startedAt!)
      }, 1000)
      return () => clearInterval(interval)
    }
    if (step.status === 'done' && step.startedAt) {
      setElapsed(Date.now() - step.startedAt)
    }
  }, [step.status, step.startedAt])

  const items: StepItem[] = step.items || (step as unknown as { actions?: StepItem[] }).actions || []

  const isRunning = step.status === 'running'

  const statusIcon = () => {
    switch (step.status) {
      case 'done':
        return (
          <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
            <Check size={11} className="text-text-secondary" strokeWidth={3} />
          </div>
        )
      case 'running':
        return (
          <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
            <Loader2 size={11} className="text-accent-blue" style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        )
      case 'incomplete':
        return (
          <div className="w-5 h-5 rounded-full bg-bg-secondary flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={11} className="text-text-secondary" strokeWidth={2.5} />
          </div>
        )
      default:
        return (
          <div className="w-5 h-5 rounded-full border border-border-tertiary flex items-center justify-center flex-shrink-0">
            <Circle size={6} className="text-text-muted/40" fill="currentColor" />
          </div>
        )
    }
  }

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 py-2 hover:bg-bg-secondary rounded-lg px-2 -mx-2 transition-all duration-150 group"
      >
        {statusIcon()}
        <span className={`chat-task-title font-semibold flex-1 text-left tracking-[0] ${
          step.status === 'done' ? 'text-text-primary' :
          step.status === 'running' ? 'text-text-primary' :
          step.status === 'incomplete' ? 'text-text-secondary' : 'text-text-tertiary'
        }`}>
          {step.title}
        </span>
        {step.startedAt && (step.status === 'running' || step.status === 'done') && (
          <span className="text-[11px] text-text-muted tabular-nums font-medium mr-1">
            {formatElapsed(elapsed)}
          </span>
        )}
        <ChevronUp
          size={13}
          className={`text-text-muted transition-transform duration-200 group-hover:text-text-secondary ${
            expanded ? '' : 'rotate-180'
          }`}
        />
      </button>

      <div
        className={`grid transition-all duration-200 ease-out ${
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="pl-[30px] pr-2 pb-2 space-y-1.5">
            {items.map((item, i) => {
              if (item.type === 'update') {
                const isLastItem = i === items.length - 1
                const isStreamingItem = isRunning && isLastItem
                return (
                  <p key={i} className="chat-task-body text-text-secondary py-1">
                    {item.content}
                    {isStreamingItem && (
                      <span className="inline-block w-[2px] h-[14px] bg-text-secondary ml-0.5 align-middle" style={{ animation: 'blink 1s step-end infinite' }} />
                    )}
                  </p>
                )
              }
              return <ActionPill key={i} action={item} />
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
