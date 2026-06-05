'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { SavedSkill, ThemeSetting } from '@/types'

export type ModelOption = string
type SavedSkillInput = Omit<SavedSkill, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<SavedSkill, 'id' | 'createdAt' | 'updatedAt'>>

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

interface SettingsStore {
  model: ModelOption
  theme: ThemeSetting
  themePreferenceSet: boolean
  language: string
  soundEnabled: boolean
  sendWithEnter: boolean
  reduceMotion: boolean
  reduceTransparency: boolean
  globalInstructions: string
  desktopNotifications: boolean
  skillLibrary: SavedSkill[]

  setModel: (model: ModelOption) => void
  setTheme: (theme: ThemeSetting) => void
  setLanguage: (lang: string) => void
  setSoundEnabled: (enabled: boolean) => void
  setSendWithEnter: (enabled: boolean) => void
  setReduceMotion: (enabled: boolean) => void
  setReduceTransparency: (enabled: boolean) => void
  setGlobalInstructions: (instructions: string) => void
  setDesktopNotifications: (enabled: boolean) => void
  addSkill: (skill: SavedSkillInput) => void
  updateSkill: (id: string, updates: Partial<Pick<SavedSkill, 'name' | 'description' | 'content'>>) => void
  removeSkill: (id: string) => void
  setSkillLibrary: (skills: SavedSkill[]) => void
  clearSkills: () => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      model: '',  // Empty = use server DEFAULT_MODEL
      theme: 'system',
      themePreferenceSet: false,
      language: 'en',
      soundEnabled: false,
      sendWithEnter: true,
      reduceMotion: false,
      reduceTransparency: false,
      globalInstructions: '',
      desktopNotifications: false,
      skillLibrary: [],

      setModel: (model: ModelOption) => set({ model }),
      setTheme: (theme: ThemeSetting) => set({ theme, themePreferenceSet: true }),
      setLanguage: (lang: string) => set({ language: lang }),
      setSoundEnabled: (enabled: boolean) => set({ soundEnabled: enabled }),
      setSendWithEnter: (enabled: boolean) => set({ sendWithEnter: enabled }),
      setReduceMotion: (enabled: boolean) => set({ reduceMotion: enabled }),
      setReduceTransparency: (enabled: boolean) => set({ reduceTransparency: enabled }),
      setGlobalInstructions: (instructions: string) => set({ globalInstructions: instructions }),
      setDesktopNotifications: (enabled: boolean) => set({ desktopNotifications: enabled }),
      addSkill: (skill: SavedSkillInput) => set((state) => {
        const now = Date.now()
        const name = skill.name.trim() || 'Untitled skill'
        const nextSkill: SavedSkill = {
          ...skill,
          id: skill.id || createId(),
          name,
          description: skill.description.trim(),
          createdAt: skill.createdAt || now,
          updatedAt: now,
        }
        const existingIndex = state.skillLibrary.findIndex((existing) =>
          existing.name.trim().toLowerCase() === name.toLowerCase()
        )
        if (existingIndex < 0) {
          return { skillLibrary: [nextSkill, ...state.skillLibrary] }
        }

        const existing = state.skillLibrary[existingIndex]
        const updated = {
          ...nextSkill,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now,
        }
        return {
          skillLibrary: state.skillLibrary.map((item, index) =>
            index === existingIndex ? updated : item
          ),
        }
      }),
      updateSkill: (id, updates) => set((state) => ({
        skillLibrary: state.skillLibrary.map((skill) =>
          skill.id === id
            ? {
                ...skill,
                ...updates,
                name: updates.name?.trim() || skill.name,
                description: updates.description?.trim() ?? skill.description,
                updatedAt: Date.now(),
              }
            : skill
        ),
      })),
      removeSkill: (id) => set((state) => ({
        skillLibrary: state.skillLibrary.filter((skill) => skill.id !== id),
      })),
      setSkillLibrary: (skills) => set({
        skillLibrary: skills.map((skill) => ({
          ...skill,
          id: skill.id || createId(),
          name: skill.name.trim() || 'Untitled skill',
          description: skill.description?.trim() || 'Saved reusable skill',
          createdAt: skill.createdAt || Date.now(),
          updatedAt: skill.updatedAt || Date.now(),
        })),
      }),
      clearSkills: () => set({ skillLibrary: [] }),
    }),
    {
      name: 'agent-settings-store',
      version: 1,
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<SettingsStore>
        if (version === 0 && state.theme === 'dark' && state.themePreferenceSet !== true) {
          return { ...state, theme: 'system' as ThemeSetting, themePreferenceSet: false }
        }
        return state
      },
      onRehydrateStorage: () => () => {
        // Settings store hydrated — no separate signal needed since
        // localStorage persist is synchronous (unlike IDB for task history)
      },
    }
  )
)
