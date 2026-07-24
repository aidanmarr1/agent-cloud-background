import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [globals, userMenu, customSelect, chatInput, creditPill, exportMenu, slashMenu, branchMenu, modelSelector, taskPage, sidebar] = await Promise.all([
  readFile(join(root, 'src/app/globals.css'), 'utf8'),
  readFile(join(root, 'src/components/ui/UserMenu.tsx'), 'utf8'),
  readFile(join(root, 'src/components/ui/CustomSelect.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/ChatInput.tsx'), 'utf8'),
  readFile(join(root, 'src/components/ui/CreditPill.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/ExportMenu.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/SlashCommandMenu.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/BranchIndicator.tsx'), 'utf8'),
  readFile(join(root, 'src/components/ui/ModelSelector.tsx'), 'utf8'),
  readFile(join(root, 'src/app/chat/[id]/page.tsx'), 'utf8'),
  readFile(join(root, 'src/components/layout/Sidebar.tsx'), 'utf8'),
])

const menuShadows = [...globals.matchAll(/--shadow-menu:\s*([^;]+);/g)].map((match) => match[1].trim())
const smallShadows = [...globals.matchAll(/--shadow-sm:\s*([^;]+);/g)].map((match) => match[1].trim())
const mediumShadows = [...globals.matchAll(/--shadow-md:\s*([^;]+);/g)].map((match) => match[1].trim())
const largeShadows = [...globals.matchAll(/--shadow-lg:\s*([^;]+);/g)].map((match) => match[1].trim())
const extraLargeShadows = [...globals.matchAll(/--shadow-xl:\s*([^;]+);/g)].map((match) => match[1].trim())

assert.equal(menuShadows.length, 3, 'light, dark, and automatic themes must define the menu shadow')
assert.deepEqual(
  menuShadows,
  [
    '0 4px 32px rgb(24 24 23 / 0.1)',
    '0 4px 32px rgb(0 0 0 / 0.16)',
    '0 4px 32px rgb(0 0 0 / 0.16)',
  ],
  'the shared elevation shadow must keep the Manus-style soft falloff in every theme',
)
for (const [label, shadows] of [
  ['small', smallShadows],
  ['medium', mediumShadows],
  ['menu', menuShadows],
  ['large', largeShadows],
  ['extra-large', extraLargeShadows],
]) {
  assert.deepEqual(shadows, menuShadows, `${label} shadows must reuse the shared floating-surface elevation recipe`)
  for (const shadow of shadows) {
    assert.doesNotMatch(shadow, /,/, `${label} shadows must use one continuous falloff instead of stacked bands`)
    assert.doesNotMatch(shadow, /-\d+px/, `${label} shadows must not compress the blur with negative spread`)
  }
}

assert.doesNotMatch(
  chatInput,
  /boxShadow:\s*focused\s*\?|focus(?:-within)?:shadow|active:shadow/,
  'focusing or pressing the task composer must not add an elevation shadow',
)
assert.match(
  globals,
  /\.task-input-surface,\s*\.task-progress-surface,\s*\.task-composer-stack\s*{[^}]*box-shadow:\s*none\s*!important;[^}]*filter:\s*none\s*!important;/s,
  'docked input and progress surfaces must remain flat while menus retain elevation',
)
assert.doesNotMatch(
  sidebar,
  /focus-within:shadow/,
  'focusing a sidebar input must not add an elevation shadow',
)

assert.match(
  globals,
  /\.menu-surface\s*{[^}]*box-shadow:\s*var\(--shadow-menu\)\s*!important;[^}]*filter:\s*none;/s,
  'menu surfaces must use one native box-shadow falloff without a filter layer',
)
assert.doesNotMatch(
  userMenu,
  /boxShadow:\s*'var\(--shadow-lg\)'/,
  'the account menu must not override the smooth semantic shadow with the old layered shadow',
)
assert.match(userMenu, /\bmenu-surface\b/, 'the account menu must use the shared menu surface')
assert.doesNotMatch(
  creditPill,
  /style=\{\{\s*boxShadow:/,
  'the credit menu must not duplicate the semantic menu shadow inline',
)
const menuSurfaceBlock = globals.match(/\.menu-surface\s*{[^}]*}/s)?.[0] ?? ''
assert.equal(
  (menuSurfaceBlock.match(/box-shadow:/g) ?? []).length,
  1,
  'menu surfaces must use exactly one box-shadow falloff',
)
assert.doesNotMatch(
  menuSurfaceBlock,
  /drop-shadow\(/,
  'menu surfaces must not use a GPU filter shadow that can produce a hard halo',
)

const popoverSources = [
  ['custom select', customSelect],
  ['attachment and saved-skill menus', chatInput],
  ['credit menu', creditPill],
  ['export menu', exportMenu],
  ['slash-command menu', slashMenu],
  ['branch menu', branchMenu],
  ['model menu', modelSelector],
  ['task actions menu', taskPage],
]

for (const [label, source] of popoverSources) {
  assert.match(
    source,
    /(?:\bmenu-surface\b|var\(--shadow-menu\))/,
    `${label} must use the smooth semantic menu shadow`,
  )
}

console.log('menu shadow smoothness smoke checks passed')
