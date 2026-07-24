'use client'

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Copy, FolderUp, Trash2, Upload } from '@/components/icons'
import { useSettingsStore } from '@/store/settings'
import { useUIStore } from '@/store/ui'
import { buildSkillCommands } from '@/lib/slashCommands'
import { formatBytes, readSkillImportsFromFiles, SKILL_IMPORT_ACCEPT } from '@/lib/fileHandling'
import { SettingsSection, settingsPanelClass } from './SettingsSection'

function sourceLabel(sourceType: string, fileCount: number): string {
  if (sourceType === 'zip') return `${fileCount} extracted file${fileCount === 1 ? '' : 's'}`
  if (sourceType === 'folder') return `${fileCount} folder file${fileCount === 1 ? '' : 's'}`
  return sourceType === 'skill' ? '.skill file' : 'text file'
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(timestamp)
}

const uploadActionButtonClass =
  'grid min-h-10 grid-cols-[16px_auto] items-center justify-center gap-2 rounded-lg border border-border-primary bg-bg-primary px-3.5 py-2 text-[12px] font-semibold leading-none text-text-secondary transition-colors duration-150 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35 disabled:cursor-not-allowed disabled:opacity-60'

export function SkillsTab() {
  const skills = useSettingsStore((s) => s.skillLibrary)
  const addSkill = useSettingsStore((s) => s.addSkill)
  const removeSkill = useSettingsStore((s) => s.removeSkill)
  const addToast = useUIStore((s) => s.addToast)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const slashNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const command of buildSkillCommands(skills)) {
      if (command.skillId) map.set(command.skillId, command.name)
    }
    return map
  }, [skills])

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
  }, [])

  const handleImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setImporting(true)
    try {
      const result = await readSkillImportsFromFiles(files)
      for (const skill of result.skills) {
        addSkill(skill)
      }
      for (const warning of result.warnings.slice(0, 2)) {
        addToast(warning, 'info')
      }
      for (const error of result.errors.slice(0, 3)) {
        addToast(error, 'error')
      }
      if (result.skills.length > 0) {
        addToast(`Imported ${result.skills.length} skill${result.skills.length === 1 ? '' : 's'}.`, 'success')
      }
    } finally {
      setImporting(false)
    }
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleImport(event.target.files)
    event.target.value = ''
  }

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      addToast(`Copied ${command}`, 'success')
    } catch {
      addToast('Could not copy command.', 'error')
    }
  }

  return (
    <div className="space-y-8">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept={SKILL_IMPORT_ACCEPT}
        multiple
        onChange={handleFileChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={handleFileChange}
      />

      <SettingsSection
        title="Import skills"
        description="Add reusable capabilities from files you already have."
      >
        <div className={`${settingsPanelClass} px-4 py-3.5`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-primary">
                <BookOpen size={15} className="text-accent-blue" strokeWidth={2.25} />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-text-primary tracking-[0]">Choose files to import</div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-text-tertiary">
                  Supports .skill, readable text, ZIP archives, and folders
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className={uploadActionButtonClass}
              >
                <Upload size={14} strokeWidth={2.25} className="justify-self-center" />
                <span className="whitespace-nowrap">{importing ? 'Importing...' : 'Upload files'}</span>
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                disabled={importing}
                className={uploadActionButtonClass}
              >
                <FolderUp size={14} strokeWidth={2.25} className="justify-self-center" />
                <span className="whitespace-nowrap">Upload folder</span>
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Saved skills"
        description={`${skills.length} skill${skills.length === 1 ? '' : 's'} available from the prompt.`}
      >
        {skills.length === 0 ? (
          <div className={`${settingsPanelClass} px-4 py-4`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3.5">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-primary">
                  <BookOpen size={15} className="text-text-muted" strokeWidth={2.25} />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-text-primary">No skills saved yet</div>
                  <div className="mt-0.5 text-[11.5px] text-text-tertiary">
                    Upload one to make it available from the prompt with /.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={uploadActionButtonClass}
              >
                <Upload size={14} strokeWidth={2.25} className="justify-self-center" />
                <span className="whitespace-nowrap">Upload skill</span>
              </button>
            </div>
          </div>
        ) : (
          <div className={`${settingsPanelClass} divide-y divide-border-primary`}>
            {skills.map((skill) => {
              const command = slashNames.get(skill.id) || `/${skill.name.toLowerCase().replace(/\s+/g, '-')}`
              return (
                <div
                  key={skill.id}
                  className="px-4 py-3.5 transition-colors duration-150 hover:bg-bg-secondary"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-1 gap-3.5">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-primary">
                        <BookOpen size={15} className="text-accent-blue" strokeWidth={2.25} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <div className="truncate text-[13px] font-semibold text-text-primary tracking-[0]">
                            {skill.name}
                          </div>
                          <span className="rounded border border-border-primary bg-bg-primary px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
                            {skill.sourceType}
                          </span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-text-secondary">
                          {skill.description}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-text-tertiary">
                          <span>{sourceLabel(skill.sourceType, skill.fileCount)}</span>
                          <span>{formatBytes(skill.size)}</span>
                          <span>Updated {formatDate(skill.updatedAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center justify-end gap-2 sm:min-w-[210px]">
                      <button
                        type="button"
                        onClick={() => handleCopyCommand(command)}
                        className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-border-primary bg-bg-primary px-2.5 font-mono text-[11px] text-text-secondary transition-colors duration-150 hover:border-border-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
                        title={`Copy ${command}`}
                        aria-label={`Copy skill command ${command}`}
                      >
                        <Copy size={12} strokeWidth={2.25} />
                        <span className="truncate">{command}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSkill(skill.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-primary bg-bg-primary text-text-muted transition-colors duration-150 hover:border-accent-red/30 hover:bg-accent-red/5 hover:text-accent-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-red/30"
                        title={`Remove ${skill.name}`}
                        aria-label={`Remove ${skill.name}`}
                      >
                        <Trash2 size={13} strokeWidth={2.25} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
