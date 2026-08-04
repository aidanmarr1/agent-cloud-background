import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [
  agentLoop,
  webIde,
  computerPanel,
  fileRoute,
  websiteRoute,
  websitePreview,
  agentMessage,
  prompts,
  toolPipeline,
  cleaners,
] = await Promise.all([
  'src/lib/agent/AgentLoop.ts',
  'src/stream/client/webIdeIntegration.ts',
  'src/components/computer/ComputerPanel.tsx',
  'src/app/api/files/route.ts',
  'src/app/api/files/website-archive/route.ts',
  'src/components/chat/WebsitePreview.tsx',
  'src/components/chat/AgentMessage.tsx',
  'src/lib/prompts.ts',
  'src/lib/agent/ToolPipeline.ts',
  'src/lib/stream/cleaners.ts',
].map(path => readFile(join(root, path), 'utf8')))

assert.match(webIde, /if \(!normalizedFilePath\) return/, 'pathless file starts must stay hidden')
assert.match(webIde, /if \(!filePath\) return[\s\S]*upsertPanel/, 'deltas received before a filename must stay buffered')
assert.match(webIde, /baseContent[\s\S]*bufferedBeforeStart/, 'buffered content must appear as soon as the real path arrives')
assert.match(computerPanel, /isEmptyPathlessFileItem[\s\S]*!isEmptyPathlessFileItem/, 'legacy pathless placeholders must be filtered from the Computer panel')

assert.match(fileRoute, /mimeType\.startsWith\('text\/html'\)/, 'saved HTML must be previewable inline')
assert.match(fileRoute, /Content-Security-Policy[\s\S]*sandbox allow-scripts/, 'website previews must run in an origin-isolated sandbox')
assert.match(websiteRoute, /website-src\/index\.html[\s\S]*website-src\/styles\.css[\s\S]*website-src\/script\.js/, 'website ZIP must include editable sources')
assert.match(websitePreview, /Download source ZIP[\s\S]*Download bundled HTML/, 'website card must expose source and bundled downloads')
assert.match(websitePreview, /iframe[\s\S]*sandbox="allow-scripts allow-forms allow-modals allow-popups"/, 'website card must render the real safe preview')
assert.match(agentMessage, /websiteArtifacts[\s\S]*<WebsitePreview/, 'website artifacts must use the first-class preview card')

assert.doesNotMatch(prompts, /Standalone HTML files open automatically/, 'website builds must not mandate localhost auto-preview')
assert.doesNotMatch(agentLoop, /LOCAL VISUAL CHECK REQUIRED|LOCAL WEBSITE SERVER CHECK REQUIRED|NEXT\.JS\/TSX LOCAL PREVIEW REQUIRED/, 'completion must not be blocked by prescribed localhost/browser QA')
assert.doesNotMatch(toolPipeline, /result = await this\.maybeLaunchWebsiteAfterWrite\(tc\.id/, 'ordinary writes must not auto-launch localhost')

assert.match(agentLoop, /compactExplicitTerminalActionMessages[\s\S]*SANDBOX TERMINAL ACTION REQUIRED: TOOL CALL ONLY/, 'explicit terminal tasks need a compact real-terminal hot path')
assert.match(agentLoop, /explicitTerminalNeedsInitialAction[\s\S]*name: 'execute_command'/, 'explicit terminal tasks must pin execute_command')
assert.match(agentLoop, /REQUIRED USER ACTION NOT YET EXECUTED[\s\S]*Do not claim the terminal/, 'generic no-terminal refusals must be rejected before completion')

assert.match(cleaners, /\(\?:I\|We\|You\|The\|This\|That\|These\|Those\|He\|She\|It\|They\)/, 'stream boundary sentence spacing repair must stay narrowly scoped')

console.log('live website, terminal recovery, and stream-boundary smoke checks passed')
