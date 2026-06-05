'use client'

export function EnhancedTable({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border-primary my-4">
      <table className="w-full text-[13px]" {...props}>
        {children}
      </table>
    </div>
  )
}

export function EnhancedThead({ children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className="bg-bg-secondary sticky top-0 border-b border-border-primary" {...props}>
      {children}
    </thead>
  )
}
