import type { ReactNode } from 'react'
import { Bot } from '@/components/icons'

function Brand() {
  return (
    <div className="flex items-center justify-center gap-2.5 text-text-primary">
      <Bot size={25} weight="regular" aria-hidden="true" />
      <span className="text-[21px] font-normal leading-none tracking-[-0.025em] [font-family:var(--font-display)]">Agent</span>
    </div>
  )
}

export function AuthPanel({
  title,
  subtitle,
  dense = false,
  children,
}: {
  title: string
  subtitle: string
  dense?: boolean
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-bg-primary px-6 py-10 sm:px-8 sm:py-12">
      <main className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[400px] flex-col justify-center sm:min-h-[calc(100dvh-6rem)]">
        <div className={`w-full ${dense ? 'py-0' : 'py-4'}`}>
          <Brand />

          <div className={`${dense ? 'mb-6 mt-8 sm:mt-9' : 'mb-8 mt-12 sm:mt-14'} text-center`}>
            <h1 className="text-[31px] font-normal leading-tight tracking-[-0.035em] text-text-primary [font-family:var(--font-display)] sm:text-[34px]">{title}</h1>
            <p className="mx-auto mt-3 max-w-[360px] text-[13.5px] leading-relaxed text-text-tertiary">{subtitle}</p>
          </div>

          {children}
        </div>

      </main>
    </div>
  )
}
