import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const modal = await readFile(join(root, 'src/components/modals/Modal.tsx'), 'utf8')

assert.match(
  modal,
  /createPortal/,
  'shared modals must portal to document.body so nested layouts cannot clip or offset them'
)

assert.match(
  modal,
  /document\.body/,
  'shared modals must render at the body layer'
)

assert.match(
  modal,
  /fixed inset-0 z-\[180\]/,
  'shared modals must keep a full-viewport overlay layer'
)

console.log('modal layer smoke checks passed')
