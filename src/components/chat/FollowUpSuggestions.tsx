'use client'

import { ArrowRight } from '@/components/icons'
import { FollowUpSuggestion } from '@/types'

interface FollowUpSuggestionsProps {
  suggestions: FollowUpSuggestion[]
  onSelect: (text: string) => void
}

export function FollowUpSuggestions({ suggestions, onSelect }: FollowUpSuggestionsProps) {
  if (!suggestions || suggestions.length === 0) return null

  return (
    <div className="mt-7 animate-fade-in-up">
      <p className="text-[13px] text-text-tertiary [font-family:var(--font-display)] mb-3">
        Suggested follow-ups
      </p>
      <div className="space-y-1.5">
        {suggestions.map((suggestion, i) => (
          <button
            key={i}
            onClick={() => onSelect(suggestion.text)}
            className="group w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border-primary bg-bg-card hover:border-border-tertiary hover:bg-bg-secondary active:scale-[0.995] transition-all duration-150 text-left"
          >
            <span className="text-[13.5px] text-text-secondary group-hover:text-text-primary transition-colors leading-snug flex-1">
              {suggestion.text}
            </span>
            <ArrowRight
              size={14}
              className="text-text-muted group-hover:text-accent-blue group-hover:translate-x-0.5 transition-all duration-200 flex-shrink-0"
              strokeWidth={2.25}
            />
          </button>
        ))}
      </div>
    </div>
  )
}
