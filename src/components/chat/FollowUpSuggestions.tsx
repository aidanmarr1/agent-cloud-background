'use client'

import { ArrowRight, MessageSquare } from '@/components/icons'
import { FollowUpSuggestion } from '@/types'

interface FollowUpSuggestionsProps {
  suggestions: FollowUpSuggestion[]
  onSelect: (text: string) => void
}

export function FollowUpSuggestions({ suggestions, onSelect }: FollowUpSuggestionsProps) {
  if (!suggestions || suggestions.length === 0) return null

  return (
    <div className="mt-5 border-t border-border-secondary animate-fade-in-up" aria-label="Suggested follow-ups">
      {suggestions.map((suggestion, i) => (
        <button
          type="button"
          key={i}
          onClick={() => onSelect(suggestion.text)}
          className="group flex min-h-11 w-full items-center gap-2.5 border-b border-border-secondary px-0.5 py-2.5 text-left transition-colors duration-100 hover:bg-bg-secondary focus-visible:bg-bg-secondary"
        >
          <MessageSquare
            size={14}
            className="ml-0.5 flex-shrink-0 text-text-muted transition-colors duration-100 group-hover:text-text-secondary"
            strokeWidth={1.9}
          />
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-text-tertiary transition-colors duration-100 group-hover:text-text-primary">
            {suggestion.text}
          </span>
          <ArrowRight
            size={13}
            className="mr-0.5 flex-shrink-0 text-text-muted transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-text-secondary"
            strokeWidth={2.1}
          />
        </button>
      ))}
    </div>
  )
}
