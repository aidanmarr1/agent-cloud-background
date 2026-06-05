'use client'

export function ChatSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="flex-1 flex flex-col min-h-screen">
        <div className="h-14 border-b border-border-primary flex-shrink-0" />
        <div className="flex-1 px-6 md:px-8 py-12">
          <div className="max-w-[820px] mx-auto space-y-10">
            {/* User message skeleton */}
            <div className="flex justify-end">
              <div className="bg-bg-secondary border border-border-primary rounded-2xl h-14 w-72 animate-skeleton-pulse" />
            </div>
            {/* Agent message skeleton */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-7 h-7 rounded-[10px] bg-bg-secondary animate-skeleton-pulse flex-shrink-0" />
                <div className="bg-bg-secondary rounded-md h-4 w-16 animate-skeleton-pulse" />
              </div>
              <div className="ml-[42px] space-y-2.5">
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[520px] animate-skeleton-pulse" style={{ animationDelay: '0.1s' }} />
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[560px] animate-skeleton-pulse" style={{ animationDelay: '0.15s' }} />
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[420px] animate-skeleton-pulse" style={{ animationDelay: '0.2s' }} />
              </div>
            </div>
            {/* Second user message */}
            <div className="flex justify-end">
              <div className="bg-bg-secondary border border-border-primary rounded-2xl h-10 w-52 animate-skeleton-pulse" style={{ animationDelay: '0.3s' }} />
            </div>
            {/* Second agent message */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-7 h-7 rounded-[10px] bg-bg-secondary animate-skeleton-pulse flex-shrink-0" style={{ animationDelay: '0.35s' }} />
                <div className="bg-bg-secondary rounded-md h-4 w-16 animate-skeleton-pulse" style={{ animationDelay: '0.35s' }} />
              </div>
              <div className="ml-[42px] space-y-2.5">
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[480px] animate-skeleton-pulse" style={{ animationDelay: '0.4s' }} />
                <div className="bg-bg-secondary rounded-md h-3.5 w-full max-w-[380px] animate-skeleton-pulse" style={{ animationDelay: '0.5s' }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
