'use client'

import { useState, useEffect } from 'react'
import { X, BookOpen, Globe2, MessageSquare } from '@/components/icons'
import { useSettingsStore } from '@/store/settings'
import { useChatStore } from '@/store/chat'
import { instructionTemplates } from '@/lib/instructionTemplates'

interface InstructionsEditorProps {
  open: boolean
  onClose: () => void
  conversationId: string
}

export function InstructionsEditor({ open, onClose, conversationId }: InstructionsEditorProps) {
  const globalInstructions = useSettingsStore((s) => s.globalInstructions)
  const setGlobalInstructions = useSettingsStore((s) => s.setGlobalInstructions)
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId))
  const setCustomInstructions = useChatStore((s) => s.setCustomInstructions)

  const [scope, setScope] = useState<'global' | 'task'>('task')
  const [text, setText] = useState('')

  useEffect(() => {
    if (open) {
      if (scope === 'global') {
        setText(globalInstructions)
      } else {
        setText(conversation?.customInstructions || '')
      }
    }
  }, [open, scope, globalInstructions, conversation?.customInstructions])

  if (!open) return null

  const handleSave = () => {
    if (scope === 'global') {
      setGlobalInstructions(text)
    } else {
      setCustomInstructions(conversationId, text)
    }
    onClose()
  }

  const handleSelectTemplate = (content: string) => {
    setText((prev) => (prev ? prev + '\n\n' + content : content))
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-[var(--overlay-scrim)] cursor-default"
        onClick={onClose}
        aria-label="Close custom instructions"
      />

      {/* Modal */}
      <div
        className="relative bg-bg-primary border border-border-primary rounded-2xl w-full max-w-[520px] mx-4 max-h-[85vh] flex flex-col overflow-hidden animate-scale-in"
        style={{ boxShadow: 'var(--shadow-xl)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-primary flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <BookOpen size={15} className="text-accent-blue" strokeWidth={2.25} />
            <h2 className="text-[17px] font-semibold text-text-primary [font-family:var(--font-display)] tracking-[0]">Custom Instructions</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
            aria-label="Close custom instructions"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scope toggle */}
        <div className="px-5 pt-4 flex-shrink-0">
          <div className="flex gap-1 p-1 bg-bg-secondary rounded-xl border border-border-primary">
            <button
              onClick={() => setScope('global')}
              className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[12px] font-medium transition-all duration-150 ${
                scope === 'global'
                  ? 'bg-bg-primary text-text-primary border border-border-primary'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Globe2 size={12} strokeWidth={2.25} />
              Global
            </button>
            <button
              onClick={() => setScope('task')}
              className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[12px] font-medium transition-all duration-150 ${
                scope === 'task'
                  ? 'bg-bg-primary text-text-primary border border-border-primary'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <MessageSquare size={12} strokeWidth={2.25} />
              This task
            </button>
          </div>
        </div>

        {/* Templates */}
        <div className="px-5 pt-4 flex-shrink-0">
          <div className="text-[12px] text-text-tertiary [font-family:var(--font-display)] mb-2.5">Templates</div>
          <div className="flex flex-wrap gap-1.5">
            {instructionTemplates.map((t) => (
              <button
                key={t.id}
                onClick={() => handleSelectTemplate(t.content)}
                className="px-2.5 h-7 bg-bg-secondary hover:bg-bg-secondary border border-border-primary hover:border-border-tertiary rounded-lg text-[11.5px] text-text-secondary font-medium transition-all duration-150"
                title={t.description}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>

        {/* Textarea */}
        <div className="px-5 py-4 flex-1 overflow-hidden flex flex-col">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={scope === 'global'
              ? 'Instructions that apply to all tasks…'
              : 'Instructions for this specific task…'
            }
            className="flex-1 w-full min-h-[160px] max-h-[320px] bg-bg-secondary border border-border-primary rounded-2xl px-4 py-3.5 text-[13px] text-text-primary leading-relaxed placeholder:text-text-muted placeholder:[font-family:var(--font-display)] resize-none outline-none hover:border-border-tertiary focus:border-border-primary transition-all duration-150"
          />
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border-primary flex items-center justify-between flex-shrink-0">
          <span className="text-[11.5px] text-text-muted tabular-nums">
            {text.length > 0 ? `${text.length} characters` : 'No instructions set'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3.5 h-9 rounded-lg text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 h-9 rounded-lg text-[13px] font-semibold text-text-on-blue bg-accent-blue hover:opacity-90 transition-opacity"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
