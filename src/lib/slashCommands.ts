import type { SavedSkill, SlashCommand } from '@/types'

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
}

export function buildSkillCommands(skills: SavedSkill[]): SlashCommand[] {
  const usedNames = new Set<string>()

  return skills.map((skill) => {
    const baseName = `/${slugify(skill.name) || 'skill'}`
    let name = baseName
    let suffix = 2
    while (usedNames.has(name)) {
      name = `${baseName}-${suffix}`
      suffix += 1
    }
    usedNames.add(name)

    return {
      name,
      label: skill.name,
      description: skill.description || skill.sourceName,
      icon: 'BookOpen',
      handler: 'skill',
      skillId: skill.id,
      source: 'skill',
    }
  })
}

export function getAllSlashCommands(skills: SavedSkill[] = []): SlashCommand[] {
  return buildSkillCommands(skills)
}

export function filterCommands(query: string, skills: SavedSkill[] = []): SlashCommand[] {
  const q = query.toLowerCase().replace('/', '')
  const commands = getAllSlashCommands(skills)
  if (!q) return commands
  return commands.filter((c) =>
    c.name.includes(q) ||
    c.label.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q)
  )
}
