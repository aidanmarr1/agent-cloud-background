'use client'

import { useState, useEffect } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import type { FileAttachment } from '@/types'

interface HeroSectionProps {
  onSubmit: (message: string, attachments?: FileAttachment[]) => void | Promise<void>
  prefillText?: string
  timeDisplay: TimeDisplay
}

// Rotating subtitles — grouped by time-of-day so the hero feels contextual.
const subtitleSets: Record<'morning' | 'afternoon' | 'evening' | 'night', string[]> = {
  morning: [
    'Plan your day with clarity',
    'Research any topic in depth',
    'Draft the first version of anything',
    'Turn rough ideas into structured plans',
  ],
  afternoon: [
    'Ship the next thing on your list',
    'Build websites and applications',
    'Analyze data and create visualizations',
    'Write, edit, and refine documents',
  ],
  evening: [
    'Wrap up what you started',
    'Review today and prep tomorrow',
    'Research the next decision',
    'Summarize what you learned today',
  ],
  night: [
    'Quiet hours, deep focus',
    'Sketch tomorrow before you sleep',
    'Capture the thought before it slips',
    'Research without interruption',
  ],
}

export type TimeBand = 'morning' | 'afternoon' | 'evening' | 'night'

export interface TimeDisplay {
  band: TimeBand
  todayLabel: string
}

interface SubtitleState {
  currentIndex: number
  previousIndex: number | null
  animationKey: number
}

export function getTimeBand(hour: number): TimeBand {
  if (hour < 5) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

function getGreeting(band: TimeBand): string {
  switch (band) {
    case 'morning':
      return 'Good morning'
    case 'afternoon':
      return 'Good afternoon'
    case 'evening':
      return 'Good evening'
    case 'night':
      return 'Working late'
  }
}

export function HeroSection({ onSubmit, prefillText, timeDisplay }: HeroSectionProps) {
  const [subtitleState, setSubtitleState] = useState<SubtitleState>({
    currentIndex: 0,
    previousIndex: null,
    animationKey: 0,
  })

  const band = timeDisplay.band
  const subtitles = subtitleSets[band]
  const greeting = getGreeting(band)
  const currentSubtitle = subtitles[subtitleState.currentIndex] ?? subtitles[0]
  const previousSubtitle = subtitleState.previousIndex !== null
    ? subtitles[subtitleState.previousIndex]
    : null

  // Reset the displayed index when the real local-time subtitle set is known.
  useEffect(() => {
    setSubtitleState({ currentIndex: 0, previousIndex: null, animationKey: 0 })
  }, [band])

  useEffect(() => {
    const interval = setInterval(() => {
      setSubtitleState((state) => {
        const nextIndex = (state.currentIndex + 1) % subtitles.length
        if (nextIndex === state.currentIndex) return state
        return {
          currentIndex: nextIndex,
          previousIndex: state.currentIndex,
          animationKey: state.animationKey + 1,
        }
      })
    }, 3400)
    return () => {
      clearInterval(interval)
    }
  }, [band, subtitles.length])

  useEffect(() => {
    if (subtitleState.previousIndex === null) return
    const animationKey = subtitleState.animationKey
    const timeout = setTimeout(() => {
      setSubtitleState((state) => (
        state.animationKey === animationKey
          ? { ...state, previousIndex: null }
          : state
      ))
    }, 620)
    return () => clearTimeout(timeout)
  }, [subtitleState.animationKey, subtitleState.previousIndex])

  return (
    <div className="flex flex-col items-center gap-5 w-full max-w-[810px] mx-auto px-3 relative">
      <div className="text-center flex flex-col items-center relative z-10">
        {/* Date */}
        <div className="mb-2.5">
          <span className="text-[10.5px] font-semibold text-text-muted uppercase tracking-[0.14em]">
            {timeDisplay.todayLabel}
          </span>
        </div>

        <h1
          className="text-[34px] md:text-[46px] font-semibold tracking-[0] text-text-primary leading-[1.05]"
        >
          {greeting}
        </h1>

        {/* Rotating subtitle */}
        <div className="mt-2.5 h-[26px] w-full flex items-center justify-center">
          <div className="home-rotating-subtitle relative h-[26px] w-full overflow-hidden text-[14px] md:text-[15px] text-text-tertiary leading-relaxed tracking-[0]">
            {previousSubtitle && (
              <span
                key={`subtitle-out-${subtitleState.animationKey}`}
                aria-hidden="true"
                className="home-rotating-subtitle__item home-rotating-subtitle__item--out"
              >
                {previousSubtitle}
              </span>
            )}
            <span
              key={`subtitle-in-${subtitleState.animationKey}`}
              className={`home-rotating-subtitle__item ${
                previousSubtitle
                  ? 'home-rotating-subtitle__item--in'
                  : 'home-rotating-subtitle__item--rest'
              }`}
            >
              {currentSubtitle}
            </span>
          </div>
        </div>
      </div>

      {/* Chat input */}
      <div className="w-full relative z-10">
        <ChatInput
          onSubmit={onSubmit}
          placeholder="Assign a task or ask anything"
          initialValue={prefillText}
        />
      </div>
    </div>
  )
}
