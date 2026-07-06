'use client'

import { useRouter } from 'next/navigation'
import { Clock } from '@/components/icons'
import { Modal } from '@/components/modals/Modal'
import { useUIStore } from '@/store/ui'

export function ActiveTaskConflictModal() {
  const router = useRouter()
  const modal = useUIStore((s) => s.activeTaskConflictModal)
  const dismiss = useUIStore((s) => s.dismissActiveTaskConflict)

  if (!modal) return null

  const openRunningTask = () => {
    if (!modal.activeConversationId) return
    dismiss()
    router.push(`/chat/${modal.activeConversationId}`)
  }

  return (
    <Modal
      open={!!modal}
      onClose={dismiss}
      title="Task could not start"
      panelClassName="max-w-[420px] max-h-[85vh]"
    >
      <div className="px-6 py-5">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-border-primary bg-bg-secondary text-text-secondary">
          <Clock size={18} strokeWidth={2.25} />
        </div>
        <p className="text-[14px] leading-relaxed text-text-secondary">
          {modal.message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          {modal.activeConversationId && (
            <button
              type="button"
              onClick={openRunningTask}
              className="h-9 rounded-lg border border-border-primary bg-bg-secondary px-3 text-[12.5px] font-semibold text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              Open running task
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="h-9 rounded-lg bg-text-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Got it
          </button>
        </div>
      </div>
    </Modal>
  )
}
