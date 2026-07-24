'use client'

export function ChatSkeleton() {
  return (
    <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
      <div className="flex-1 flex flex-col h-full min-h-0">
        <div className="h-14 border-b border-border-primary flex-shrink-0" />
        <div className="flex-1 overflow-hidden px-6 py-8 md:px-8">
          <div className="max-w-[810px] mx-auto space-y-7">
            {/* User message skeleton */}
            <div className="flex justify-end">
              <div className="bg-bg-secondary border border-border-primary rounded-2xl h-14 w-72 animate-skeleton-pulse" />
            </div>
            {/* Agent response skeleton */}
            <div className="space-y-2.5">
              <div className="bg-bg-secondary rounded-md h-4 w-24 animate-skeleton-pulse" />
              <div className="space-y-2.5">
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[520px] animate-skeleton-pulse" style={{ animationDelay: '0.1s' }} />
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[560px] animate-skeleton-pulse" style={{ animationDelay: '0.15s' }} />
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[420px] animate-skeleton-pulse" style={{ animationDelay: '0.2s' }} />
              </div>
            </div>
            {/* Second user message */}
            <div className="flex justify-end">
              <div className="bg-bg-secondary border border-border-primary rounded-2xl h-10 w-52 animate-skeleton-pulse" style={{ animationDelay: '0.3s' }} />
            </div>
            {/* Second agent response */}
            <div className="space-y-2.5">
              <div className="bg-bg-secondary rounded-md h-4 w-20 animate-skeleton-pulse" style={{ animationDelay: '0.35s' }} />
              <div className="space-y-2.5">
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[480px] animate-skeleton-pulse" style={{ animationDelay: '0.4s' }} />
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[380px] animate-skeleton-pulse" style={{ animationDelay: '0.5s' }} />
              </div>
            </div>
          </div>
        </div>
        <div className="flex-shrink-0 border-t border-border-secondary px-3 pb-3 pt-3 sm:px-5 sm:pb-5">
          <div className="mx-auto h-[88px] max-w-[810px] rounded-[14px] border border-border-primary bg-bg-card animate-skeleton-pulse" />
        </div>
      </div>
    </div>
  )
}
