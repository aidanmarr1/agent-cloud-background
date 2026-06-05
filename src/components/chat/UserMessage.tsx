'use client'

import { Message } from '@/types'
import { MessageActions } from './MessageActions'
import { AttachmentPreviewRow } from './AttachmentPreview'

interface UserMessageProps {
  message: Message
}

export function UserMessage({ message }: UserMessageProps) {
  const attachmentCount = message.attachments?.length ?? 0

  return (
    <div className="animate-slide-in-from-right group relative">
      <MessageActions
        variant="user"
        onCopy={() => navigator.clipboard.writeText(message.content)}
      />
      <div className="bg-bg-message-user rounded-2xl px-5 py-4 max-w-[88%] md:max-w-[75%] ml-auto transition-all duration-200 border border-border-primary">
        {message.attachments && attachmentCount > 0 && (
          <div className="mb-3 flex max-h-[212px] flex-col gap-1.5 overflow-y-auto rounded-xl border border-border-primary bg-bg-secondary p-1.5">
            <div className="flex h-6 items-center px-1">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-text-muted">
                {attachmentCount === 1 ? '1 context item sent' : `${attachmentCount} context items sent`}
              </span>
            </div>
            {message.attachments.map((att, i) => (
              <AttachmentPreviewRow
                key={`${att.name}-${i}`}
                attachment={att}
                density="message"
              />
            ))}
          </div>
        )}
        <p className="chat-user-text text-text-primary whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    </div>
  )
}
