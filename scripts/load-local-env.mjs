import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function loadLocalEnvFiles(rootUrl, options = {}) {
  const override = options.override === true
  const files = options.files || ['.env', '.env.local']
  const preexisting = new Set(Object.keys(process.env))

  for (const name of files) {
    const path = fileURLToPath(new URL(name, rootUrl))
    if (!existsSync(path)) continue

    const raw = readFileSync(path, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!match) continue

      const [, key, rawValue] = match
      if (!override && preexisting.has(key)) continue
      process.env[key] = parseEnvValue(rawValue)
    }
  }
}
