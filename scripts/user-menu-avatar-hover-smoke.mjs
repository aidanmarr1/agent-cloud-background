import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const userMenu = await readFile(join(root, 'src/components/ui/UserMenu.tsx'), 'utf8')

const triggerClass = userMenu.match(/<button\s+onClick=\{\(\) => setOpen\(!open\)\}\s+className="([^"]+)"/s)?.[1] ?? ''

assert.match(triggerClass, /rounded-full/, 'the profile trigger must stay circular')
assert.match(triggerClass, /hover:opacity-70/, 'the profile trigger must use a clearly visible opacity fade on hover')
assert.match(triggerClass, /active:opacity-60/, 'the pressed state must remain distinct from hover')
assert.match(triggerClass, /transition-opacity/, 'the profile hover feedback must animate only opacity')
assert.doesNotMatch(triggerClass, /hover:bg-/, 'the profile trigger must not add a hover background box')
assert.doesNotMatch(triggerClass, /hover:border-/, 'the profile trigger must not add a hover border box')
assert.doesNotMatch(triggerClass, /hover:ring-/, 'the profile trigger must not add a hover ring')
assert.doesNotMatch(triggerClass, /hover:shadow-/, 'the profile trigger must not add a hover shadow')
assert.match(triggerClass, /focus-visible:ring-2/, 'the profile trigger must retain a circular keyboard focus indicator')
assert.match(userMenu, /aria-expanded=\{open\}/, 'the profile trigger must expose its open state')
assert.match(userMenu, /aria-haspopup="menu"/, 'the profile trigger must identify the menu it opens')
assert.match(userMenu, /data-no-focus-ring=""/, 'the profile trigger must opt out of the global box-shaped focus outline')

console.log('user menu avatar hover smoke checks passed')
