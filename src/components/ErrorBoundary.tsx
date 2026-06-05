'use client'

import React from 'react'
import Link from 'next/link'
import { AlertTriangle, RotateCcw, Home } from '@/components/icons'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallbackMessage?: string
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-[50vh] p-8">
          <div className="text-center space-y-5 max-w-sm">
            <div className="w-14 h-14 rounded-2xl bg-accent-red/8 flex items-center justify-center mx-auto">
              <AlertTriangle size={24} className="text-accent-red" />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold text-text-primary mb-1.5 [font-family:var(--font-display)]">
                {this.props.fallbackMessage || 'Something went wrong'}
              </h3>
              <p className="text-[13px] text-text-muted leading-relaxed">
                Please try again. If it keeps happening, return home and start from there.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2.5">
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="inline-flex items-center gap-2 px-4 py-2 bg-text-primary text-primary-foreground hover:opacity-90 rounded-lg text-[13px] font-medium transition-all active:scale-95"
              >
                <RotateCcw size={13} />
                Try again
              </button>
              <Link
                href="/"
                className="inline-flex items-center gap-2 px-4 py-2 bg-bg-secondary border border-border-primary hover:bg-bg-tertiary rounded-lg text-[13px] font-medium text-text-secondary transition-colors"
              >
                <Home size={13} />
                Go home
              </Link>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
