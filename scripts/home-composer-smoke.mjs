import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const homePage = await readFile(join(root, 'src/app/page.tsx'), 'utf8')
const heroSection = await readFile(join(root, 'src/components/home/HeroSection.tsx'), 'utf8')
const chatInput = await readFile(join(root, 'src/components/chat/ChatInput.tsx'), 'utf8')

assert.doesNotMatch(
  homePage,
  /useHydration/,
  'home composer must not depend on async store hydration'
)

assert.match(
  heroSection,
  /What can I do for you\?/
  ,
  'home hero must keep the primary task invitation visible'
)

assert.match(
  heroSection,
  /text-\[33px\][^"\n]*sm:text-\[41px\][^"\n]*lg:text-\[46px\]/,
  'home greeting must keep the slightly reduced responsive scale'
)

assert.match(
  heroSection,
  /<ChatInput[\s\S]*?placeholder="Assign a task or type \/ for more"/,
  'home page must always render the hero task input'
)

assert.doesNotMatch(
  chatInput,
  /VoiceInput|Start voice input|Stop voice input/,
  'the shared home and in-task composer must not expose voice input'
)

assert.doesNotMatch(
  homePage,
  /RecentConversations|LaunchCard|DEFAULT_TIME_DISPLAY/,
  'home should stay focused on the task composer without legacy dashboard cards or time-dependent copy'
)

console.log('home composer smoke checks passed')
