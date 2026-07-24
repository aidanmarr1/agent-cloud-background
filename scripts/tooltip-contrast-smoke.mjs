import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const globals = await readFile(join(root, 'src/app/globals.css'), 'utf8')
const controlTooltip = await readFile(join(root, 'src/components/ui/ControlTooltip.tsx'), 'utf8')
const sidebar = await readFile(join(root, 'src/components/layout/Sidebar.tsx'), 'utf8')
const sidebarItem = await readFile(join(root, 'src/components/layout/SidebarItem.tsx'), 'utf8')

assert.match(
  globals,
  /--tooltip-surface:\s*#030303;/,
  'tooltips must use the near-black Manus surface in every color mode'
)

assert.match(
  globals,
  /--tooltip-text:\s*#ffffff;/,
  'tooltips must preserve high-contrast white text'
)

for (const [name, source] of [
  ['shared control tooltip', controlTooltip],
  ['sidebar tooltips', sidebar],
  ['legacy sidebar item tooltip', sidebarItem],
]) {
  assert.match(
    source,
    /bg-\[var\(--tooltip-surface\)\]/,
    `${name} must consume the shared tooltip surface token`
  )
  assert.match(
    source,
    /text-\[var\(--tooltip-text\)\]/,
    `${name} must consume the shared tooltip text token`
  )
  assert.doesNotMatch(
    source,
    /bg-\[#151515\]/,
    `${name} must not retain the low-contrast tooltip color`
  )
}

assert.match(
  sidebar,
  /group-focus-within\/sidebar-label:opacity-100/,
  'collapsed sidebar labels must remain visible for keyboard focus'
)

assert.match(
  sidebar,
  /group-focus-within\/header-search:opacity-100/,
  'expanded sidebar header labels must remain visible for keyboard focus'
)

assert.match(
  sidebar,
  /renderCollapsed \? 'group\/sidebar-label relative mx-3' : 'px-3'/,
  'collapsed New task must anchor its tooltip to the 40px control, not the padded 64px rail'
)

assert.match(
  sidebar,
  /renderCollapsed \? 'group\/sidebar-label relative mx-3 mb-3 mt-3 flex-shrink-0' : 'flex-shrink-0 p-3'/,
  'collapsed Settings must keep spacing outside its positioned anchor so its tooltip centers on the 40px control'
)

assert.equal(
  (sidebar.match(/left-\[calc\(100%\+10px\)\]/g) || []).length,
  2,
  'horizontal sidebar tooltips must share the same 10px control-edge gap'
)

console.log('tooltip contrast smoke checks passed')
