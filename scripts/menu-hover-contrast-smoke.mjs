import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const read = (path) => readFile(join(root, path), 'utf8')

const [
  globals,
  chatInput,
  slashMenu,
  exportMenu,
  branchMenu,
  modelSelector,
  customSelect,
  commandPalette,
  userMenu,
  taskPage,
  searchResults,
  projectFiles,
] = await Promise.all([
  read('src/app/globals.css'),
  read('src/components/chat/ChatInput.tsx'),
  read('src/components/chat/SlashCommandMenu.tsx'),
  read('src/components/chat/ExportMenu.tsx'),
  read('src/components/chat/BranchIndicator.tsx'),
  read('src/components/ui/ModelSelector.tsx'),
  read('src/components/ui/CustomSelect.tsx'),
  read('src/components/ui/CommandPalette.tsx'),
  read('src/components/ui/UserMenu.tsx'),
  read('src/app/chat/[id]/page.tsx'),
  read('src/components/computer/SearchResults.tsx'),
  read('src/components/ui/ProjectFiles.tsx'),
])

assert.equal(
  globals.match(/--bg-hover:\s*var\(--sidebar-hover\);/g)?.length,
  3,
  'light, dark, and automatic themes must share the sidebar hover surface',
)

const menuSurfaces = [
  ['attachment menu', chatInput],
  ['slash-command menu', slashMenu],
  ['export menu', exportMenu],
  ['branch menu', branchMenu],
  ['model menu', modelSelector],
  ['custom select', customSelect],
  ['command palette', commandPalette],
  ['account menu', userMenu],
  ['task actions menu', taskPage],
]

for (const [label, source] of menuSurfaces) {
  assert.match(source, /(?:hover:|bg-)bg-hover/, `${label} must use the stronger shared hover surface`)
}

assert.match(chatInput, /hover:bg-bg-hover focus-visible:bg-bg-hover/, 'attachment rows must expose the same surface for pointer and keyboard users')
assert.match(chatInput, /disabled:hover:bg-transparent/, 'disabled attachment rows must stay visually inactive')
assert.match(slashMenu, /isActive \? 'bg-bg-hover'/, 'keyboard-selected slash commands must use the stronger hover surface')
assert.match(customSelect, /isActive \? 'bg-bg-hover/, 'keyboard-selected options must use the stronger hover surface')
assert.match(commandPalette, /selectedIndex === idx \? 'bg-bg-hover'/, 'keyboard-selected command rows must use the stronger hover surface')
assert.doesNotMatch(taskPage, /hover:bg-bg-hover transition-all/, 'task action rows must mirror their hover surface for keyboard focus')

const standardActionRadiusSources = [
  ['model option', modelSelector, /role="option"[\s\S]*?className="[^"]*\brounded-lg\b/],
  ['account menu rows', userMenu, /hover:bg-bg-hover[^"]*\brounded-lg\b/],
  ['command palette rows', commandPalette, /data-palette-index[\s\S]*?\brounded-lg\b/],
  ['computer search result rows', searchResults, /const className = '[^']*\brounded-lg\b/],
  ['project file rows', projectFiles, /group flex items-center gap-3 rounded-lg/],
]

for (const [label, source, pattern] of standardActionRadiusSources) {
  assert.match(source, pattern, `${label} must use the shared 8px action and hover radius`)
}

console.log('menu hover contrast smoke checks passed')
