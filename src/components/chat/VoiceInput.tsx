'use client'

import { useEffect, useRef } from 'react'
import { Mic, MicOff } from '@/components/icons'
import { useSpeechRecognition } from '@/lib/useSpeechRecognition'
import { useUIStore } from '@/store/ui'

interface VoiceInputProps {
  onTranscript: (text: string) => void
}

export function VoiceInput({ onTranscript }: VoiceInputProps) {
  const { start, stop, isListening, interimTranscript, finalTranscript, isSupported, error } = useSpeechRecognition()
  const addToast = useUIStore((s) => s.addToast)

  // Parent passes a fresh inline arrow each render, so we stash the latest
  // callback in a ref and depend only on `finalTranscript` below. Without this,
  // every parent re-render (e.g. on each keystroke) re-fires the effect and
  // delivers the same transcript again.
  const onTranscriptRef = useRef(onTranscript)
  useEffect(() => {
    onTranscriptRef.current = onTranscript
  })

  const deliveredLengthRef = useRef(0)
  useEffect(() => {
    if (!finalTranscript) {
      deliveredLengthRef.current = 0
      return
    }
    const nextChunk = finalTranscript.slice(deliveredLengthRef.current)
    deliveredLengthRef.current = finalTranscript.length
    if (nextChunk.trim()) {
      onTranscriptRef.current(nextChunk)
    }
  }, [finalTranscript])

  const lastErrorRef = useRef('')
  useEffect(() => {
    if (!error || error === lastErrorRef.current) return
    lastErrorRef.current = error
    addToast(error, 'error')
  }, [addToast, error])

  if (!isSupported) return null

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (isListening) {
            stop()
          } else {
            void start()
          }
        }}
        aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
        aria-pressed={isListening}
        className={`subtle-icon-button w-9 h-9 rounded-full flex items-center justify-center transition-all duration-150 active:scale-[0.96] ${
          isListening
            ? 'is-danger'
            : ''
        }`}
        title={isListening ? 'Stop voice input' : 'Start voice input'}
      >
        {isListening
          ? <MicOff size={15} strokeWidth={2.25} weight="regular" />
          : <Mic size={15} strokeWidth={2.25} weight="regular" />
        }
        {isListening && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent-red animate-pulse" />
        )}
      </button>
      {isListening && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 menu-surface border border-border-primary rounded-xl text-[11.5px] text-text-secondary [font-family:var(--font-display)] whitespace-nowrap max-w-[220px] truncate animate-fade-in"
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          {interimTranscript || 'Listening...'}
        </div>
      )}
    </div>
  )
}
