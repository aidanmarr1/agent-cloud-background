import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const homePage = await readFile(join(root, 'src/app/page.tsx'), 'utf8')

assert.doesNotMatch(
  homePage,
  /useHydration/,
  'home composer must not depend on async store hydration'
)

assert.doesNotMatch(
  homePage,
  /hydrated\s*&&\s*timeDisplay|:\s*null/,
  'home composer must not render null while waiting for hydration/time effects'
)

assert.match(
  homePage,
  /DEFAULT_TIME_DISPLAY/,
  'home composer must have deterministic initial time display content'
)

assert.match(
  homePage,
  /<HeroSection[\s\S]*?<ChatInput|<HeroSection[\s\S]*?timeDisplay=\{timeDisplay\}/,
  'home page must always render the hero task input'
)

console.log('home composer smoke checks passed')
