import Image from 'next/image'

export function AuthPanel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-12">
      <div className="w-full max-w-[420px] rounded-2xl border border-border-primary bg-bg-card p-7 shadow-[var(--shadow-md)]">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary">
            <Image src="/logo.svg" alt="Agent" width={32} height={32} className="h-8 w-8 rounded-lg object-contain" />
          </div>
          <div>
            <div className="text-[17px] font-semibold tracking-[0] text-text-primary">Agent</div>
            <div className="text-[12.5px] text-text-muted">Secure account access</div>
          </div>
        </div>

        <div className="mb-6">
          <h1 className="text-[23px] font-semibold tracking-[0] text-text-primary">{title}</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">{subtitle}</p>
        </div>

        {children}
      </div>
    </div>
  )
}
