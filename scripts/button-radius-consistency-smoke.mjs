import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const targets = [
  ['sidebar', 'src/components/layout/Sidebar.tsx'],
  ['legacy sidebar item', 'src/components/layout/SidebarItem.tsx'],
  ['settings modal', 'src/components/modals/SettingsModal.tsx'],
  ['shared composer', 'src/components/chat/ChatInput.tsx'],
  ['browser activity view', 'src/components/computer/BrowserView.tsx'],
  ['sign in', 'src/app/sign-in/page.tsx'],
  ['sign up', 'src/app/sign-up/page.tsx'],
  ['task not found action', 'src/app/chat/[id]/page.tsx'],
  ['deleted-account action', 'src/components/auth/AccountDeletedGate.tsx'],
  ['image preview actions', 'src/components/chat/ImagePreview.tsx'],
  ['generic action primitive', 'src/components/ui/rainbow-button.tsx'],
]

const sources = await Promise.all(
  targets.map(async ([label, path]) => [label, await readFile(join(root, path), 'utf8')]),
)

for (const [label, source] of sources) {
  assert.doesNotMatch(
    source,
    /(?:button[\s\S]{0,320}|<button[\s\S]{0,320})rounded-\[12px\]/,
    `${label} must not reintroduce the legacy 12px action radius`,
  )
}

for (const [label, source] of sources.filter(([label]) => (
  ['sign in', 'sign up', 'task not found action', 'deleted-account action', 'generic action primitive'].includes(label)
))) {
  assert.doesNotMatch(
    source,
    /type="submit"[\s\S]{0,320}rounded-xl|Back to home[\s\S]{0,320}rounded-xl|Log out[\s\S]{0,320}rounded-xl|inline-flex[\s\S]{0,240}rounded-xl/,
    `${label} must use the established rounded-lg action radius`,
  )
}

const sidebar = sources.find(([label]) => label === 'sidebar')?.[1] ?? ''
assert.doesNotMatch(
  sidebar,
  /(?:Open menu|Close menu)[\s\S]{0,240}rounded-xl|rounded-xl[\s\S]{0,240}(?:Open menu|Close menu)/,
  'mobile sidebar controls must match the desktop rounded-lg controls',
)

const imagePreview = sources.find(([label]) => label === 'image preview actions')?.[1] ?? ''
assert.doesNotMatch(
  imagePreview,
  /rounded-xl[\s\S]{0,200}aria-label="Close preview"/,
  'fullscreen image close controls must use the shared action radius',
)

const settingsModal = sources.find(([label]) => label === 'settings modal')?.[1] ?? ''
assert.match(
  settingsModal,
  /panelClassName="max-w-\[1160px\] h-\[756px\] max-h-\[calc\(100dvh-2rem\)\]"/,
  'the settings dialog must keep the slightly narrower, slightly shorter responsive desktop dimensions',
)
assert.match(
  settingsModal,
  /data-settings-section=\{item\.id\}[\s\S]{0,220}rounded-lg/,
  'mobile settings section controls must use the established rounded-lg action radius',
)

const chatInput = sources.find(([label]) => label === 'shared composer')?.[1] ?? ''
assert.match(
  chatInput,
  /aria-label="Remove all attached files"[\s\S]{0,220}rounded-lg/,
  'the attachment clear-all control must use the established rounded-lg action radius',
)

const browserView = sources.find(([label]) => label === 'browser activity view')?.[1] ?? ''
assert.match(
  browserView,
  /onClick=\{onJumpToLive\}[\s\S]{0,180}rounded-lg/,
  'the Jump to live control must use the established rounded-lg action radius',
)

console.log('button radius consistency smoke checks passed')
