import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.tsx-preview-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createFileInSandbox, getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { isWebsiteEntryPath } from ${JSON.stringify(join(root, 'src/lib/localWebsiteServer.ts'))}
import {
  buildTsxWebsitePreviewLaunch,
  getNextWebsiteProjectStatus,
  isNextWebsiteProjectPath,
  stopTsxWebsitePreviewServer,
} from ${JSON.stringify(join(root, 'src/lib/tsxWebsitePreview.ts'))}

async function write(conversationId: string, path: string, content: string) {
  const result = await createFileInSandbox(conversationId, path, content)
  assert.equal(result.path, path)
  assert.ok((result.size || 0) > 0, \`expected \${path} to be written\`)
}

export async function runSmoke() {
  const goodId = \`tsx-preview-smoke-\${Date.now()}\`
  const badId = \`\${goodId}-bad\`

  try {
    await rm(getSandboxDirPath(goodId), { recursive: true, force: true })
    await rm(getSandboxDirPath(badId), { recursive: true, force: true })

    assert.equal(isNextWebsiteProjectPath('app/page.tsx'), true)
    assert.equal(isNextWebsiteProjectPath('components/Hero.tsx'), true)
    assert.equal(isNextWebsiteProjectPath('src/lib/server.ts'), false)
    assert.equal(isWebsiteEntryPath('index.html'), true)
    assert.equal(isNextWebsiteProjectPath('index.html'), false)

    let status = await getNextWebsiteProjectStatus(goodId)
    assert.deepEqual(status.missingFiles, ['app/page.tsx', 'app/layout.tsx', 'app/globals.css'])
    assert.equal(status.ready, false)

    await write(goodId, 'app/page.tsx', \`
import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { Hero } from '../components/Hero'

export default function Page() {
  const pathname = usePathname()
  return (
    <main className="shell">
      <Hero />
      <p data-path={pathname}>Preview is live.</p>
      <Link href="/demo">Demo link</Link>
      <Image src="/logo.svg" alt="Logo" width={32} height={32} />
      <button type="button" onClick={() => document.body.dataset.clicked = 'true'}>Try control</button>
    </main>
  )
}
\`)
    await write(goodId, 'components/Hero.tsx', \`
export function Hero() {
  return <section className="hero"><h1>TSX Preview Smoke</h1></section>
}
\`)
    await write(goodId, 'app/layout.tsx', \`
import './globals.css'

export const metadata = { title: 'Preview Smoke' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
\`)
    await write(goodId, 'app/globals.css', \`
html, body { margin: 0; min-height: 100%; font-family: system-ui, sans-serif; }
.shell { min-height: 100vh; padding: 32px; background: #f8fafc; color: #111827; }
.hero { border: 1px solid #d1d5db; border-radius: 8px; padding: 24px; background: #ffffff; }
button { min-height: 40px; border: 1px solid #111827; border-radius: 6px; background: #111827; color: white; padding: 0 14px; }
\`)

    status = await getNextWebsiteProjectStatus(goodId)
    assert.equal(status.ready, true)
    assert.equal(status.complete, true)
    assert.deepEqual(status.missingFiles, [])
    assert.equal(status.layoutImportsGlobalCss, true)

    const launch = await buildTsxWebsitePreviewLaunch(goodId)
    assert.match(launch.url, /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//)

    const html = await fetch(launch.url)
    assert.equal(html.status, 200)
    assert.match(await html.text(), /Generated Website Preview/)

    const js = await fetch(\`\${launch.origin}/dist/preview.js\`)
    assert.equal(js.status, 200)
    assert.match(await js.text(), /TSX Preview Smoke|PreviewRoot/)

    const css = await fetch(\`\${launch.origin}/dist/preview.css\`)
    assert.equal(css.status, 200)
    assert.match(await css.text(), /\\.shell/)

    await write(badId, 'app/page.tsx', \`
import { Hero } from '../components/Hero'

export default function Page() {
  return <main className="shell"><Hero /></main>
}
\`)
    await write(badId, 'components/Hero.tsx', 'export function Hero() { return <section className="hero"><h1>Broken</h1></section> }')
    await write(badId, 'app/layout.tsx', 'export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }')
    await write(badId, 'app/globals.css', \`
html, body { margin: 0; min-height: 100%; font-family: system-ui, sans-serif; }
.shell { min-height: 100vh; padding: 32px; background: #f8fafc; color: #111827; }
.hero { border: 1px solid #d1d5db; border-radius: 8px; padding: 24px; background: #ffffff; }
button { min-height: 40px; border: 1px solid #111827; border-radius: 6px; background: #111827; color: white; padding: 0 14px; }
\`)
    const badStatus = await getNextWebsiteProjectStatus(badId)
    assert.equal(badStatus.ready, true)
    assert.equal(badStatus.complete, false)
    assert.equal(badStatus.layoutImportsGlobalCss, false)
    assert.ok(badStatus.structureIssues.join(' ').includes("Import './globals.css' from app/layout.tsx"))
  } finally {
    await stopTsxWebsitePreviewServer(goodId)
    await stopTsxWebsitePreviewServer(badId)
    await rm(getSandboxDirPath(goodId), { recursive: true, force: true })
    await rm(getSandboxDirPath(badId), { recursive: true, force: true })
  }
}
`, 'utf-8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    external: ['esbuild'],
    logLevel: 'silent',
  })

  const { runSmoke } = await import(pathToFileURL(bundlePath).href)
  await runSmoke()
  console.log('tsx website preview smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
