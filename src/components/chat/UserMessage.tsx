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
    <article className="animate-slide-in-from-right group relative flex justify-end [@media(hover:none)]:pt-3" aria-label="Your message">
      <MessageActions
        variant="user"
        onCopy={() => navigator.clipboard.writeText(message.content)}
      />
      <div className="w-fit max-w-[94%] overflow-hidden rounded-[18px] rounded-br-md border border-border-primary bg-bg-message-user px-4 py-3 transition-colors duration-200 sm:max-w-[84%] sm:px-4.5 sm:py-3.5 md:max-w-[72%]">
        {message.attachments && attachmentCount > 0 && (
          <div className={`${message.content ? 'mb-3' : ''} scrollbar-none flex max-w-full gap-2 overflow-x-auto`}>
            {message.attachments.map((att, i) => (
              <AttachmentPreviewRow
                key={`${att.name}-${i}`}
                attachment={att}
                density="message"
              />
            ))}
          </div>
        )}
        {message.content && (
          <p className="chat-user-text whitespace-pre-wrap break-words text-text-primary">
            {message.content}
          </p>
        )}
      </div>
    </article>
  )
}
