'use client'

import { useMemo } from 'react'
import { Message, TaskStep as TaskStepType } from '@/types'
import { TaskStep } from './TaskStep'
import { FollowUpSuggestions } from './FollowUpSuggestions'
import { ThinkingView } from './ThinkingView'
import { MessageActions } from './MessageActions'
import { CompletionBanner } from './CompletionBanner'
import { DocumentPreview } from './DocumentPreview'
import { ImagePreview } from './ImagePreview'
import { TaskGroupView } from './TaskGroupView'
import { TypingIndicator } from './TypingIndicator'
import { MarkdownLite } from './MarkdownLite'
import { splitTaskMessageContent } from '@/lib/stream/taskMessageContent'
import { cleanThinkingTokens } from '@/lib/stream/cleaners'
import { Bot } from '@/components/icons'

interface AgentMessageProps {
  message: Message
  isStreaming?: boolean
  onFollowUp?: (text: string) => void
  onRegenerate?: () => void
  conversationId?: string
}

export function AgentMessage({ message, isStreaming, onFollowUp, onRegenerate, conversationId }: AgentMessageProps) {
  const steps: TaskStepType[] = message.steps || []
  const taskGroups = Array.isArray(message.taskGroups) ? message.taskGroups : []
  const visibleTaskGroups = taskGroups.filter((group) => group.status !== 'pending')
  const currentRunningGroupId = [...visibleTaskGroups]
    .sort((a, b) => a.index - b.index)
    .reverse()
    .find((group) => group.status === 'running')?.id
  const visibleSteps = steps.filter((step) => step.status !== 'pending')
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
  const completedGroupCount = taskGroups.filter((g) => g.status === 'done').length
  const placeReasoningAfterAnswer = Boolean(finalContent) && showFinalContent && !isStreaming

  // Calculate total elapsed time for CompletionBanner
  const totalElapsed = (() => {
    if (!hasGroups) return undefined
    const firstStart = taskGroups.find((g) => g.startedAt)?.startedAt
    if (!firstStart) return undefined
    return Date.now() - firstStart
  })()

  // Count sources (browse + search subtasks)
  const sourceCount = taskGroups.reduce((acc, g) => {
    const subtasks = Array.isArray(g.subtasks) ? g.subtasks : []
    return acc + subtasks.filter((s) => s.status === 'done' && (s.type === 'search' || s.type === 'browse')).length
  }, 0)

  return (
    <article
      className="animate-slide-in-from-left group relative min-w-0 [@media(hover:none)]:pt-3"
      aria-label="Assistant response"
    >
      {/* Message actions */}
      {(finalContent || acknowledgment) && (
        <MessageActions
          variant="assistant"
          onCopy={() => navigator.clipboard.writeText(cleanedContent)}
          onRegenerate={onRegenerate}
        />
      )}

      <div className="w-full max-w-[860px]">
        <div className="task-activity-row mb-4 flex h-7 items-center gap-1 text-text-primary" aria-hidden="true">
          <span className="task-activity-marker flex h-5 w-5 flex-shrink-0 items-center justify-start text-text-secondary">
            <Bot size={18} strokeWidth={1.9} />
          </span>
          <span className="text-[14px] font-semibold tracking-[-0.01em] [font-family:var(--font-display)]">Agent</span>
        </div>

        {/* Keep live reasoning close to active work; completed reasoning moves below the answer. */}
        {message.reasoning && !placeReasoningAfterAnswer && (
          <ThinkingView
            reasoning={message.reasoning}
            isStreaming={!!isStreaming}
            hasContent={!!(finalContent || acknowledgment)}
          />
        )}

        {/* Keep the opening acknowledgement with the work record, including after completion. */}
        {(hasGroups || hasSteps) && acknowledgment && (
          <div className="task-acknowledgment mb-3 max-w-[860px] chat-reading-text text-text-secondary">
            {acknowledgment}
          </div>
        )}

        {/* Task history remains readable above the result instead of disappearing at completion. */}
        {visibleTaskGroups.length > 0 && (
          <section
            className="mb-6 space-y-0.5"
            aria-label={showCompletion ? 'Completed task history' : 'Task activity'}
          >
            {visibleTaskGroups.map((group) => (
              <TaskGroupView
                key={group.id}
                group={group}
                isCurrentGroup={group.id === currentRunningGroupId}
              />
            ))}
          </section>
        )}

        {/* Legacy Steps (old conversations) */}
        {!hasGroups && visibleSteps.length > 0 && (
          <div className="mb-6 space-y-0.5">
            <div className="space-y-0.5">
              {visibleSteps.map((step) => (
                <TaskStep key={step.index} step={step} />
              ))}
            </div>
          </div>
        )}

        {/* Final content is the visual anchor of the response. */}
        {showFinalContent && finalContent && (
          <div className="max-w-[860px] markdown-content chat-reading-text text-text-primary [&>:first-child]:mt-0 [&>:last-child]:mb-0">
            <MarkdownLite>{finalContent}</MarkdownLite>
          </div>
        )}

        {/* Live activity indicator — shows immediately while the first agent turn is booting/planning. */}
        {isStreaming && visibleTaskGroups.length === 0 && visibleSteps.length === 0 && (
          <div className={finalContent ? 'mt-4' : ''}>
            <TypingIndicator />
          </div>
        )}

        {/* Document previews */}
        {showFinalContent && documentArtifacts.length > 0 && (
          <div className="mt-5 max-w-[860px] space-y-3">
            {[...documentArtifacts].reverse().map((artifact) => (
              <DocumentPreview key={artifact.id} artifact={artifact} conversationId={conversationId} />
            ))}
          </div>
        )}

        {/* Image previews */}
        {showFinalContent && imageArtifacts.length > 0 && (
          <div className={imageArtifacts.length > 1
            ? 'mt-5 grid max-w-[860px] grid-cols-1 gap-3 sm:grid-cols-2'
            : 'mt-5 max-w-[860px] space-y-3'
          }>
            {[...imageArtifacts].reverse().map((artifact) => (
              <ImagePreview key={artifact.id} artifact={artifact} compact={imageArtifacts.length > 1} />
            ))}
          </div>
        )}

        {/* Finished reasoning and execution metadata are available without preceding the result. */}
        {message.reasoning && placeReasoningAfterAnswer && (
          <ThinkingView
            reasoning={message.reasoning}
            isStreaming={false}
            hasContent
          />
        )}

        {showCompletion && (
          <CompletionBanner
            completedSteps={completedGroupCount}
            totalSteps={taskGroups.length}
            elapsedMs={totalElapsed}
            sourceCount={sourceCount}
            taskGroups={taskGroups}
          />
        )}

        {/* Follow-up suggestions */}
        {followUps.length > 0 && !isStreaming && onFollowUp && (
          <div className="mt-1">
            <FollowUpSuggestions suggestions={followUps} onSelect={onFollowUp} />
          </div>
        )}

        {message.timestamp && !isStreaming && !showCompletion && (
          <div className="mt-3 text-[10px] tabular-nums text-text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </div>
        )}
      </div>
    </article>
  )
}
