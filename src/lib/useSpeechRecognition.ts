'use client'

import { useState, useRef, useCallback, useEffect } from 'react'

/* ---------- Web Speech API type declarations ---------- */

interface SpeechRecognitionResultItem {
  transcript: string
  confidence: number
}

interface SpeechRecognitionResult {
  readonly length: number
  readonly isFinal: boolean
  [index: number]: SpeechRecognitionResultItem
}

interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEventPayload {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorPayload {
  readonly error: string
  readonly message: string
}

interface SpeechRecognitionInstance {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventPayload) => void) | null
  onerror: ((event: SpeechRecognitionErrorPayload) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

/* ---------- Hook ---------- */

interface SpeechRecognitionHook {
  start: () => Promise<void>
  stop: () => void
  isListening: boolean
  interimTranscript: string
  finalTranscript: string
  isSupported: boolean
  error: string | null
}

function normalizeSpeechError(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was blocked'
    case 'audio-capture':
      return 'No microphone was found'
    case 'network':
      return 'Voice input could not connect'
    case 'no-speech':
      return 'No speech was detected'
    case 'aborted':
      return 'Voice input stopped'
    default:
      return 'Voice input failed'
  }
}

export function useSpeechRecognition(): SpeechRecognitionHook {
  const [isListening, setIsListening] = useState(false)
  const [interimTranscript, setInterimTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const [isSupported, setIsSupported] = useState(false)

  useEffect(() => {
    setIsSupported('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  }, [])

  const start = useCallback(async () => {
    if (!isSupported) {
      setError('Speech recognition not supported')
      return
    }
    if (isListening) return

    try {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!Ctor) {
        setError('Speech recognition not available')
        return
      }

      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((track) => track.stop())
      }

      recognitionRef.current?.abort()
      const recognition = new Ctor()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'en-US'

      recognition.onresult = (event) => {
        let interim = ''
        let final = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript
          if (event.results[i].isFinal) {
            final += transcript
          } else {
            interim += transcript
          }
        }
        setInterimTranscript(interim)
        if (final) setFinalTranscript(prev => prev + final)
      }

      recognition.onerror = (event) => {
        setError(normalizeSpeechError(event.error))
        setIsListening(false)
      }

      recognition.onend = () => {
        setIsListening(false)
      }

      recognitionRef.current = recognition
      recognition.start()
      setIsListening(true)
      setError(null)
      setFinalTranscript('')
      setInterimTranscript('')
    } catch (startError) {
      const name = startError instanceof DOMException ? startError.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('Microphone permission was blocked')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('No microphone was found')
      } else {
        setError('Failed to start speech recognition')
      }
      setIsListening(false)
    }
  }, [isListening, isSupported])

  const stop = useCallback(() => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }, [])

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
    }
  }, [])

  return { start, stop, isListening, interimTranscript, finalTranscript, isSupported, error }
}
