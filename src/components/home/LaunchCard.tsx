'use client'

export function LaunchCard() {
  return (
    <div className="w-full max-w-[560px] mx-auto mt-[clamp(4.5rem,11vh,8rem)] translate-y-[clamp(7rem,14vh,12rem)] px-3">
      <section
        className="group relative flex h-24 w-full overflow-hidden rounded-2xl border border-border-primary bg-bg-secondary"
        aria-label="The launch of Agent 1.0 uses Agent Credits"
      >
        <div className="flex min-w-0 flex-1 flex-col justify-center px-5 py-4 md:px-6">
          <span className="text-[16.5px] font-semibold leading-tight tracking-[0] text-text-primary [font-family:var(--font-display)]">
            The launch of Agent 1.0
          </span>
          <span className="mt-1.5 max-w-[24rem] text-[12px] leading-snug text-text-tertiary">
            Agent Credits power your first tasks.
          </span>
        </div>

        <div className="relative h-full w-[108px] shrink-0 md:w-[126px]">
          <img
            src="/assets/agent-1-launch-credits.png"
            alt=""
            className="absolute bottom-1.5 right-4 h-[84px] w-[84px] object-contain md:right-5"
            draggable={false}
          />
        </div>
      </section>

      <div className="mt-4 flex justify-center">
        <span
          className="h-2 w-2 rounded-full bg-text-muted/55"
          aria-label="Launch slide 1 of 1"
        />
      </div>
    </div>
  )
}
