import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [chatPage, computerPanel, globalsCss, uiStore] = await Promise.all([
  readFile(join(root, 'src/app/chat/[id]/page.tsx'), 'utf8'),
  readFile(join(root, 'src/components/computer/ComputerPanel.tsx'), 'utf8'),
  readFile(join(root, 'src/app/globals.css'), 'utf8'),
  readFile(join(root, 'src/store/ui.ts'), 'utf8'),
])

assert.match(chatPage, /data-chat-layout=""/, 'chat and computer panes must share one measured split layout')
assert.match(chatPage, /--computer-panel-width': `\$\{computerPanelWidth\}%`/, 'the split must expose one shared panel width variable')
assert.doesNotMatch(chatPage, /\[data-chat-main\] \{ margin-right:/, 'the task pane must not use a viewport-mismatched percentage margin')
assert.doesNotMatch(chatPage, /transition-\[margin\]/, 'the task pane must not trail the pointer through a margin transition')

assert.match(computerPanel, /handle\.setPointerCapture\(pointerId\)/, 'panel resizing must retain pointer capture across embedded content')
assert.match(computerPanel, /window\.requestAnimationFrame\(paintWidth\)/, 'panel resizing must coalesce visual updates to animation frames')
assert.match(computerPanel, /setComputerPanelWidth\(nextWidthPercent\)/, 'panel width must persist once the gesture finishes')
assert.doesNotMatch(computerPanel, /const onMove[\s\S]{0,500}setComputerPanelWidth\(/, 'raw pointer moves must not write to the global persisted store')
assert.match(computerPanel, /MIN_COMPUTER_PANEL_PX = 380/, 'the computer pane must retain a usable minimum width')
assert.match(computerPanel, /MIN_CHAT_PANE_PX = 620/, 'the task pane must retain a readable minimum width')
assert.match(computerPanel, /Math\.min\(MAX_COMPUTER_PANEL_PERCENT, Math\.max\(MIN_COMPUTER_PANEL_PERCENT, widthPercent\)\)/, 'live resizing must use the persisted percentage bounds and avoid a release snap')
assert.match(computerPanel, /layout\.style\.setProperty\('--computer-panel-width', `\$\{useUIStore\.getState\(\)\.computerPanelWidth\}%`\)/, 'resize cleanup must restore the persisted width if the panel unmounts mid-gesture')

assert.match(globalsCss, /@container chat-split \(min-width: 1000px\)/, 'split mode must depend on the actual post-sidebar workspace width')
assert.match(globalsCss, /width: clamp\(380px, var\(--computer-panel-width, 30%\), calc\(100cqw - 620px\)\)/, 'desktop split width must protect both pane minimums')
assert.match(globalsCss, /body\[data-computer-panel-resizing='true'\] \.computer-panel-shell/, 'dragging must disable panel animation and transitions')

assert.match(uiStore, /function normalizeComputerPanelWidth\(/, 'persisted panel widths must be normalized')
assert.match(uiStore, /computerPanelWidth: normalizeComputerPanelWidth\(saved\?\.computerPanelWidth/, 'hydration must reject invalid stored widths')

console.log('Computer panel resize smoke test passed')
