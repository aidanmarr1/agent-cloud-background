'use client'

import { useEffect, useRef } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import type { FileAttachment } from '@/types'

interface HeroSectionProps {
  onSubmit: (message: string, attachments?: FileAttachment[]) => void | Promise<void>
  prefillText?: string
}

export function HeroSection({ onSubmit, prefillText }: HeroSectionProps) {
  const inputRegionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!prefillText) return
    const frame = requestAnimationFrame(() => {
      inputRegionRef.current?.querySelector('textarea')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [prefillText])

  return (
    <section className="relative w-full" aria-labelledby="home-greeting">
      <div className="mx-auto max-w-[780px] text-center">
        <h1
          id="home-greeting"
          className="text-[33px] font-normal leading-[1.05] tracking-[-0.025em] text-text-primary [font-family:var(--font-display)] sm:text-[41px] lg:text-[46px]"
        >
          What can I do for you?
        </h1>
      </div>

      <div ref={inputRegionRef} className="relative z-10 mx-auto mt-8 w-full max-w-[780px] sm:mt-10">
        <ChatInput
          onSubmit={onSubmit}
          placeholder="Assign a task or type / for more"
          initialValue={prefillText}
        />
      </div>
    </section>
  )
}
