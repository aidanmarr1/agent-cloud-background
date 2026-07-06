'use client'

import { useMemo } from 'react'
import { Message, TaskStep as TaskStepType } from '@/types'
import { TaskStep } from './TaskStep'
import { FollowUpSuggestions } from './FollowUpSuggestions'
import { ThinkingView } from './ThinkingView'
import { MessageActions } from './MessageActions'
import { CompletionBanner } from './CompletionBanner'
import Image from 'next/image'
import { DocumentPreview } from './DocumentPreview'
import { ImagePreview } from './ImagePreview'
import { TaskGroupView } from './TaskGroupView'
import { TypingIndicator } from './TypingIndicator'
import { MarkdownLite } from './MarkdownLite'
import { splitTaskMessageContent } from '@/lib/stream/taskMessageContent'
import { cleanThinkingTokens } from '@/lib/stream/cleaners'

interface AgentMessageProps {
  message: Message
  isStreaming?: boolean
  onFollowUp?: (text: string) => void
  onRegenerate?: () => void
  conversationId?: string
}

export function AgentMessage({ message, isStreaming, onFollowUp, onRegenerate, conversationId }: AgentMessageProps) {
  const steps: TaskStepType[] = message.steps || []
  const taskGroups = message.taskGroups || []
  const activeGroups = taskGroups.filter(
    (g) => g.status === 'running' || g.subtasks.length > 0 || g.narrations.length > 0 || g.synthesis
  )
  const followUps = message.followUps || []
  const artifacts = message.artifacts || []
  const visibleArtifacts = artifacts.filter(a => (a.purpose ?? (a.deliverable === false ? 'support' : 'deliverable')) === 'deliverable')
  const documentArtifacts = visibleArtifacts.filter(a => a.type === 'document')
  const nonImageDeliverableArtifacts = visibleArtifacts.filter(a => a.type !== 'image')
  const imageArtifacts = artifacts.filter(a => (
    a.type === 'image' &&
    (a.purpose ?? (a.deliverable === false ? 'support' : 'deliverable')) === 'deliverable' &&
    (a.deliverable === true || nonImageDeliverableArtifacts.length === 0)
  ))
  const hasSteps = steps.length > 0
  const hasGroups = taskGroups.length > 0

  const cleanedContent = useMemo(() =>
    cleanThinkingTokens(message.content)
      .replace(/\\([[\]])/g, '$1')
      .replace(/<\s*\|?\s*(?:begin|end)[_\s]*of[_\s]*thinking\s*\|?\s*>/gi, '')
      .replace(/\b(?:end_of_thinking|begin_of_thinking|end_thinking|begin_thinking)\b/gi, '')
      .replace(/\*{0,2}\[PLAN\]\*{0,2}[\s\S]*?\*{0,2}\[\/PLAN\]\*{0,2}/gi, '')
      .replace(/\[PLAN\]\s*\n(?:[ \t]*(?:\d+[.)]\s+|-\s+|\*\s+).+(?:\n|$))+/gi, '')
      .replace(/\[STEP \d+:[\s\S]*?\[\/STEP \d+\]/gi, '')
      .replace(/\[STEP \d+:.*?\]/gi, '')
      .replace(/\[\/STEP \d+\]/gi, '')
      .replace(/^\]\s+/, '')
      .trim()
  , [message.content])

  const { acknowledgment, finalContent } = splitTaskMessageContent(cleanedContent, hasGroups || hasSteps)

  const showFinalContent = (() => {
    if (hasGroups) {
      return taskGroups.every((g) => g.status === 'done')
    }
    if (hasSteps) {
      const allDone = steps.every((s) => s.status === 'done')
      const lastRunning = steps[steps.length - 1]?.status === 'running'
      return allDone || lastRunning
    }
    return true
  })()

  const hasGroupError = hasGroups && taskGroups.some((g) => g.status === 'error' || g.status === 'incomplete')
  const allPlannedGroupsDone = hasGroups && taskGroups.every((g) => g.status === 'done')
  const showCompletion = allPlannedGroupsDone && !hasGroupError && !isStreaming

  // Calculate total elapsed time for CompletionBanner
  const totalElapsed = (() => {
    if (!hasGroups) return undefined
    const firstStart = taskGroups.find((g) => g.startedAt)?.startedAt
    if (!firstStart) return undefined
    return Date.now() - firstStart
  })()

  // Count sources (browse + search subtasks)
  const sourceCount = taskGroups.reduce((acc, g) => {
    return acc + g.subtasks.filter((s) => s.status === 'done' && (s.type === 'search' || s.type === 'browse')).length
  }, 0)

  return (
    <div className="animate-slide-in-from-left group relative">
      {/* Message actions */}
      {(finalContent || acknowledgment) && (
        <MessageActions
          variant="assistant"
          onCopy={() => navigator.clipboard.writeText(cleanedContent)}
          onRegenerate={onRegenerate}
        />
      )}

      {/* Agent header */}
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-7 h-7 rounded-lg overflow-hidden flex-shrink-0 border border-border-primary">
          <Image src="/logo.svg" alt="" width={28} height={28} />
        </div>
        <span className="text-[13px] font-semibold text-text-primary tracking-[0]">Agent</span>
        {message.timestamp && !isStreaming && (
          <span className="text-[10.5px] text-text-muted tabular-nums">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
      </div>

      {/* Reasoning/Thinking visualization */}
      {message.reasoning && (
        <div className="ml-0 sm:ml-[42px]">
          <ThinkingView
            reasoning={message.reasoning}
            isStreaming={!!isStreaming}
            hasContent={!!(finalContent || acknowledgment)}
          />
        </div>
      )}

      {/* Acknowledgment text — always visible above groups */}
      {(hasGroups || hasSteps) && acknowledgment && (
        <div className="ml-0 mb-2 chat-reading-text text-text-primary sm:ml-[42px]">
          {acknowledgment}
        </div>
      )}

      {/* Task Groups */}
      {hasGroups && (
        <div className="ml-0 mb-3 space-y-1 sm:ml-[42px]">
          {activeGroups.map((group) => (
            <TaskGroupView key={group.id} group={group} />
          ))}
        </div>
      )}

      {/* Legacy Steps (old conversations) */}
      {!hasGroups && hasSteps && (
        <div className="ml-0 mb-3 sm:ml-[42px]">
          <div className="space-y-0.5">
            {steps.map((step) => (
              <TaskStep key={step.index} step={step} />
            ))}
          </div>
        </div>
      )}

      {/* Completion banner */}
      {showCompletion && (
        <div className="ml-0 sm:ml-[42px]">
          <CompletionBanner
            completedSteps={taskGroups.filter((g) => g.status === 'done').length}
            totalSteps={taskGroups.length}
            elapsedMs={totalElapsed}
            sourceCount={sourceCount}
            taskGroups={taskGroups}
          />
        </div>
      )}

      {/* Final content */}
      {showFinalContent && finalContent && (
        <div className="ml-0 mt-4 markdown-content chat-reading-text text-text-primary sm:ml-[42px]">
          <MarkdownLite>{finalContent}</MarkdownLite>
        </div>
      )}

      {/* Live activity indicator — shows immediately while the first agent turn is booting/planning */}
      {isStreaming && !hasGroups && !hasSteps && (
        <div className="ml-0 mt-3 sm:ml-[42px]">
          <TypingIndicator />
        </div>
      )}

      {/* Document previews */}
      {showFinalContent && documentArtifacts.length > 0 && (
        <div className="ml-0 mt-4 space-y-3 sm:ml-[42px]">
          {[...documentArtifacts].reverse().map((artifact) => (
            <DocumentPreview key={artifact.id} artifact={artifact} conversationId={conversationId} />
          ))}
        </div>
      )}

      {/* Image previews */}
      {showFinalContent && imageArtifacts.length > 0 && (
        <div className={imageArtifacts.length > 1
          ? 'ml-0 mt-4 grid grid-cols-1 gap-3 max-w-[760px] sm:ml-[42px] sm:grid-cols-2'
          : 'ml-0 mt-4 space-y-3 sm:ml-[42px]'
        }>
          {[...imageArtifacts].reverse().map((artifact) => (
            <ImagePreview key={artifact.id} artifact={artifact} compact={imageArtifacts.length > 1} />
          ))}
        </div>
      )}

      {/* Follow-up suggestions */}
      {followUps.length > 0 && !isStreaming && onFollowUp && (
        <div className="ml-0 sm:ml-[42px]">
          <FollowUpSuggestions suggestions={followUps} onSelect={onFollowUp} />
        </div>
      )}
    </div>
  )
}
