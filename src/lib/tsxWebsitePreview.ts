import { constants } from 'fs'
import { createServer, type Server } from 'http'
import { extname, isAbsolute, join, relative, resolve } from 'path'
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import type { Plugin } from 'esbuild'
import { getOrCreateSandboxDir, isInsideSandbox, resolveAndVerify } from './sandbox'

interface WebsitePreviewServer {
  conversationId: string
  rootDir: string
  server: Server
  port: number
  origin: string
  lastUsed: number
}

export interface NextWebsiteProjectStatus {
  rootDir: string
  appDir: 'app' | 'src/app'
  requiredFiles: string[]
  missingFiles: string[]
  componentFiles: string[]
  pageImportsComponent: boolean
  cssHasSubstantiveStyles: boolean
  layoutImportsGlobalCss: boolean
  structureIssues: string[]
  ready: boolean
  complete: boolean
}

export interface TsxWebsitePreviewLaunch {
  url: string
  origin: string
  port: number
  rootDir: string
  previewDir: string
  appDir: 'app' | 'src/app'
}

const servers = new Map<string, WebsitePreviewServer>()
const managedPorts = new Set<number>()
const SAFE_SEGMENT = /%2f|%5c/i
const TSX_PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "navigate-to 'self'",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

const REQUIRED_LAYOUTS: Array<{ appDir: 'app' | 'src/app'; required: string[] }> = [
  { appDir: 'app', required: ['app/page.tsx', 'app/layout.tsx', 'app/globals.css'] },
  { appDir: 'src/app', required: ['src/app/page.tsx', 'src/app/layout.tsx', 'src/app/globals.css'] },
]

const NEXT_SHIMS: Record<string, string> = {
  'next/link': `
    import React from 'react'
    function hrefToString(href) {
      if (typeof href === 'string') return href
      if (href && typeof href === 'object') return href.pathname || '#'
      return '#'
    }
    export default function Link({ href, children, ...props }) {
      return React.createElement('a', { href: hrefToString(href), ...props }, children)
    }
  `,
  'next/image': `
    import React from 'react'
    export default function Image({ src, alt = '', fill, width, height, priority, quality, placeholder, blurDataURL, ...props }) {
      const normalized = typeof src === 'string' ? src : (src && src.src) || ''
      const style = fill ? { ...(props.style || {}), position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: props.objectFit || 'cover' } : props.style
      return React.createElement('img', { src: normalized, alt, width: fill ? undefined : width, height: fill ? undefined : height, ...props, style })
    }
  `,
  'next/navigation': `
    export function usePathname() {
      return typeof window === 'undefined' ? '/' : window.location.pathname
    }
    export function useSearchParams() {
      return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
    }
    export function useParams() {
      return {}
    }
    export function useRouter() {
      return {
        push(url) { if (typeof window !== 'undefined') window.location.assign(String(url)) },
        replace(url) { if (typeof window !== 'undefined') window.location.replace(String(url)) },
        prefetch() {},
        refresh() {},
        back() { if (typeof window !== 'undefined') window.history.back() },
        forward() { if (typeof window !== 'undefined') window.history.forward() },
      }
    }
    export function redirect(url) {
      if (typeof window !== 'undefined') window.location.assign(String(url))
    }
    export function notFound() {
      throw new Error('notFound() was called during preview rendering')
    }
  `,
  'next/head': `
    import React from 'react'
    export default function Head({ children }) {
      return React.createElement(React.Fragment, null, children)
    }
  `,
  'next/script': `
    export default function Script() {
      return null
    }
  `,
  'next/font/google': `
    const font = { className: '', variable: '', style: {} }
    export function Geist() { return font }
    export function Geist_Mono() { return font }
    export function Inter() { return font }
    export function Roboto() { return font }
    export function Open_Sans() { return font }
    export function Lora() { return font }
    export function Montserrat() { return font }
    export function Playfair_Display() { return font }
    export function DM_Sans() { return font }
    export function Manrope() { return font }
    export function Space_Grotesk() { return font }
    export function Plus_Jakarta_Sans() { return font }
  `,
  'next/font/local': `
    const font = { className: '', variable: '', style: {} }
    export default function localFont() { return font }
  `,
}

function normalizeSandboxPath(filePath: string): string {
  return filePath.replace(/^\.?\/+/, '').replace(/\/+/g, '/')
}

function toPosixPath(filePath: string): string {
  return filePath.split('\\').join('/')
}

function decodeRequestPath(urlPath: string): string | null {
  const raw = urlPath.replace(/^\/+/, '') || 'index.html'
  if (SAFE_SEGMENT.test(raw)) return null
  try {
    return normalizeSandboxPath(decodeURIComponent(raw)) || 'index.html'
  } catch {
    return null
  }
}

async function fileExists(rootDir: string, relPath: string): Promise<boolean> {
  const filePath = join(rootDir, relPath)
  if (!isInsideSandbox(rootDir, filePath) || !await resolveAndVerify(rootDir, filePath)) return false
  try {
    const info = await stat(/* turbopackIgnore: true */ filePath)
    return info.isFile()
  } catch {
    return false
  }
}

async function readTextIfExists(rootDir: string, relPath: string): Promise<string> {
  const filePath = join(rootDir, relPath)
  if (!isInsideSandbox(rootDir, filePath) || !await resolveAndVerify(rootDir, filePath)) return ''
  try {
    return await readFile(/* turbopackIgnore: true */ filePath, 'utf-8')
  } catch {
    return ''
  }
}

async function listFilesRecursively(rootDir: string, relDir: string, maxFiles = 80): Promise<string[]> {
  const baseDir = join(rootDir, relDir)
  const found: string[] = []
  if (!isInsideSandbox(rootDir, baseDir) || !await resolveAndVerify(rootDir, baseDir)) return found

  async function walk(currentAbs: string, currentRel: string): Promise<void> {
    if (found.length >= maxFiles) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(/* turbopackIgnore: true */ currentAbs, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (found.length >= maxFiles) break
      if (entry.name.startsWith('.')) continue
      const childAbs = join(currentAbs, entry.name)
      const childRel = toPosixPath(join(currentRel, entry.name))
      if (entry.isDirectory()) {
        if (await resolveAndVerify(rootDir, childAbs)) {
          await walk(childAbs, childRel)
        }
      } else if (entry.isFile()) {
        if (await resolveAndVerify(rootDir, childAbs)) {
          found.push(childRel)
        }
      }
    }
  }

  await walk(baseDir, relDir)
  return found
}

async function listComponentFiles(rootDir: string, appDir: 'app' | 'src/app'): Promise<string[]> {
  const candidateDirs = Array.from(new Set(['components', 'src/components', `${appDir}/components`]))
  const nested = await Promise.all(candidateDirs.map(dir => listFilesRecursively(rootDir, dir)))
  return nested
    .flat()
    .filter(file => /\.(?:tsx|jsx)$/i.test(file))
    .sort()
}

function pageUsesLocalComponent(pageContent: string): boolean {
  return /from\s+['"](?:@\/components|\.{1,2}\/components|[^'"]*\/components\/)[^'"]*['"]/i.test(pageContent)
}

function cssLooksSubstantive(cssContent: string): boolean {
  const css = cssContent
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]+;/gi, '')
    .trim()
  if (css.length < 180) return false

  const declarations = css.match(/[a-z-]+\s*:\s*[^;{}]+;/gi) || []
  const ruleBlocks = css.match(/[^{}]+\{[^{}]*:[^{}]*\}/g) || []
  const namedSelectors = css.match(/(?:^|[\s,{])(?:\.|#|body\b|main\b|section\b|header\b|nav\b|footer\b|:root\b)/gi) || []

  return declarations.length >= 6 && ruleBlocks.length >= 2 && namedSelectors.length >= 2
}

function layoutImportsStylesheet(layoutContent: string): boolean {
  return /^\s*import\s+(?:[^'"]+\s+from\s+)?['"][^'"]*globals\.css['"]/im.test(layoutContent)
}

async function resolveExistingImport(basePath: string): Promise<string | null> {
  const candidates = [
    basePath,
    `${basePath}.tsx`,
    `${basePath}.ts`,
    `${basePath}.jsx`,
    `${basePath}.js`,
    `${basePath}.css`,
    `${basePath}.json`,
    join(basePath, 'index.tsx'),
    join(basePath, 'index.ts'),
    join(basePath, 'index.jsx'),
    join(basePath, 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      const info = await stat(/* turbopackIgnore: true */ candidate)
      if (info.isFile()) return candidate
    } catch {
      // Try the next extension.
    }
  }
  return null
}

function conciseBuildErrors(err: unknown): string {
  const errors = (err as { errors?: Array<{ text?: string; location?: { file?: string; line?: number; column?: number } }> })?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.slice(0, 5).map(error => {
      const loc = error.location
      const file = loc?.file ? toPosixPath(loc.file).split('/').slice(-3).join('/') : ''
      const position = loc?.line ? `${file}:${loc.line}${loc.column ? `:${loc.column}` : ''}` : file
      return `${position ? position + ' - ' : ''}${error.text || 'Build failed'}`
    }).join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

function nextShimPlugin(): Plugin {
  return {
    name: 'next-shims',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^next\/(?:link|image|navigation|head|script|font\/google|font\/local)$/ }, args => ({
        path: args.path,
        namespace: 'next-shim',
      }))
      buildApi.onLoad({ filter: /.*/, namespace: 'next-shim' }, args => ({
        contents: NEXT_SHIMS[args.path],
        loader: 'js',
        resolveDir: process.cwd(),
      }))
    },
  }
}

function sandboxResolutionPlugin(rootDir: string, previewDir: string): Plugin {
  return {
    name: 'sandbox-resolution',
    setup(buildApi) {
      const nodeModulesDir = join(process.cwd(), 'node_modules')
      const insideAllowedRoot = (resolved: string) =>
        isInsideSandbox(rootDir, resolved) || isInsideSandbox(previewDir, resolved)
      const resolvesInsideAllowedRoot = async (resolved: string) =>
        (isInsideSandbox(rootDir, resolved) && await resolveAndVerify(rootDir, resolved)) ||
        (isInsideSandbox(previewDir, resolved) && await resolveAndVerify(previewDir, resolved))

      buildApi.onResolve({ filter: /^@\// }, async args => {
        const relPath = args.path.slice(2)
        const candidates = [join(rootDir, relPath), join(rootDir, 'src', relPath)]
        for (const candidate of candidates) {
          const resolved = await resolveExistingImport(candidate)
          if (resolved && await resolvesInsideAllowedRoot(resolved)) return { path: resolved }
        }
        return {
          errors: [{ text: `Could not resolve alias import "${args.path}" from the generated website project.` }],
        }
      })

      buildApi.onResolve({ filter: /^\.{1,2}\// }, async args => {
        if (args.namespace && args.namespace !== 'file') return undefined
        if (isInsideSandbox(nodeModulesDir, args.resolveDir)) return undefined
        const candidate = resolve(args.resolveDir, args.path)
        if (!insideAllowedRoot(candidate)) {
          return {
            errors: [{ text: `Blocked import outside the sandbox: ${args.path}` }],
          }
        }
        const resolved = await resolveExistingImport(candidate)
        if (resolved && await resolvesInsideAllowedRoot(resolved)) return { path: resolved }
        return undefined
      })

      buildApi.onResolve({ filter: /^\// }, args => {
        const candidate = resolve(args.path)
        if (!insideAllowedRoot(candidate)) {
          return {
            errors: [{ text: `Blocked absolute import outside the sandbox: ${args.path}` }],
          }
        }
        return resolvesInsideAllowedRoot(candidate).then((allowed) => {
          if (!allowed) {
            return {
              errors: [{ text: `Blocked absolute import outside the sandbox: ${args.path}` }],
            }
          }
          return { path: candidate }
        })
      })
    },
  }
}

async function resolveSafeFile(rootDir: string, requestPath: string): Promise<string | null> {
  const resolved = resolve(rootDir, requestPath)
  if (isAbsolute(requestPath) || !isInsideSandbox(rootDir, resolved)) return null
  try {
    const info = await stat(/* turbopackIgnore: true */ resolved)
    if (!info.isFile()) return null
    return await resolveAndVerify(rootDir, resolved) ? resolved : null
  } catch {
    return null
  }
}

async function createPreviewServer(conversationId: string, rootDir: string): Promise<WebsitePreviewServer> {
  const server = createServer(async (req, res) => {
    const method = req.method || 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end('Method not allowed')
      return
    }

    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    const requestPath = decodeRequestPath(requestUrl.pathname)
    if (!requestPath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad request')
      return
    }

    const filePath = await resolveSafeFile(rootDir, requestPath)
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    let file: Awaited<ReturnType<typeof open>> | null = null
    try {
      file = await open(/* turbopackIgnore: true */ filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const fileInfo = await file.stat()
      const ext = extname(filePath).toLowerCase()
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
        'Content-Length': fileInfo.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Content-Security-Policy': TSX_PREVIEW_CSP,
      })
      if (method === 'HEAD') {
        await file.close()
        return res.end()
      }
      file.createReadStream().pipe(res)
    } catch {
      await file?.close().catch(() => {})
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      res.end('Not found')
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      rejectListen(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', onListening)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to start TSX website preview server')
  }

  const port = address.port
  const origin = `http://127.0.0.1:${port}`
  managedPorts.add(port)

  server.on('close', () => {
    managedPorts.delete(port)
    const current = servers.get(conversationId)
    if (current?.port === port) servers.delete(conversationId)
  })

  return {
    conversationId,
    rootDir,
    server,
    port,
    origin,
    lastUsed: Date.now(),
  }
}

async function getOrStartPreviewServer(conversationId: string, previewDir: string): Promise<WebsitePreviewServer> {
  const existing = servers.get(conversationId)
  if (existing && existing.rootDir === previewDir) {
    existing.lastUsed = Date.now()
    return existing
  }

  if (existing) {
    await new Promise<void>((resolveClose) => existing.server.close(() => resolveClose()))
  }

  const created = await createPreviewServer(conversationId, previewDir)
  servers.set(conversationId, created)
  return created
}

export async function stopTsxWebsitePreviewServer(conversationId: string): Promise<void> {
  const existing = servers.get(conversationId)
  if (!existing) return
  await new Promise<void>((resolveClose) => existing.server.close(() => resolveClose()))
}

export function isNextWebsiteProjectPath(filePath: string): boolean {
  const clean = normalizeSandboxPath(filePath).toLowerCase().split('?')[0].split('#')[0]
  if (!clean || clean.startsWith('.agent-preview/')) return false
  if (/^(src\/)?app\/(?:page|layout)\.(?:t|j)sx$/.test(clean)) return true
  if (/^(src\/)?app\/globals\.(?:css|scss)$/.test(clean)) return true
  if (/^(src\/)?app\/.+\.(?:tsx|jsx|css|scss)$/.test(clean)) return true
  if (/^(src\/)?components\/.+\.(?:tsx|jsx|css|scss|svg)$/.test(clean)) return true
  if (/\.(?:tsx|jsx|css|scss)$/.test(clean) && /\b(?:app|page|layout|component|components|ui|style|styles)\b/.test(clean)) return true
  return /\.(?:ts|js)$/.test(clean) && /\b(?:app|page|layout|component|components|ui)\b/.test(clean)
}

export async function getNextWebsiteProjectStatus(conversationId: string): Promise<NextWebsiteProjectStatus> {
  const rootDir = await getOrCreateSandboxDir(conversationId)
  const scored = await Promise.all(REQUIRED_LAYOUTS.map(async layout => {
    const existing = await Promise.all(layout.required.map(relPath => fileExists(rootDir, relPath)))
    return {
      ...layout,
      existingCount: existing.filter(Boolean).length,
      missingFiles: layout.required.filter((_, idx) => !existing[idx]),
    }
  }))

  scored.sort((a, b) => b.existingCount - a.existingCount || (a.appDir === 'app' ? -1 : 1))
  const best = scored[0]
  const componentFiles = await listComponentFiles(rootDir, best.appDir)
  const pageContent = await readTextIfExists(rootDir, `${best.appDir}/page.tsx`)
  const layoutContent = await readTextIfExists(rootDir, `${best.appDir}/layout.tsx`)
  const cssContent = await readTextIfExists(rootDir, `${best.appDir}/globals.css`)
  const pageImportsComponent = componentFiles.length > 0 && pageUsesLocalComponent(pageContent)
  const cssHasSubstantiveStyles = cssLooksSubstantive(cssContent)
  const layoutImportsGlobalCss = layoutImportsStylesheet(layoutContent)
  const structureIssues = [
    componentFiles.length > 0 ? '' : 'Create at least one reusable TSX component under components/ or app/components/ and render it from page.tsx.',
    pageImportsComponent ? '' : 'Import and render a local component from app/page.tsx; a lone page/home TSX file is not a complete website build.',
    cssHasSubstantiveStyles ? '' : 'Add substantive authored CSS in globals.css for layout, typography, spacing, responsive behavior, and visual polish.',
    layoutImportsGlobalCss ? '' : `Import './globals.css' from ${best.appDir}/layout.tsx so the generated Next.js app loads the authored stylesheet instead of default browser styles.`,
  ].filter(Boolean)

  return {
    rootDir,
    appDir: best.appDir,
    requiredFiles: best.required,
    missingFiles: best.missingFiles,
    componentFiles,
    pageImportsComponent,
    cssHasSubstantiveStyles,
    layoutImportsGlobalCss,
    structureIssues,
    ready: best.missingFiles.length === 0,
    complete: best.missingFiles.length === 0 && structureIssues.length === 0,
  }
}

export function isManagedWebsitePreviewUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  return isLocal && managedPorts.has(Number(url.port))
}

export async function buildTsxWebsitePreviewLaunch(conversationId: string): Promise<TsxWebsitePreviewLaunch> {
  const status = await getNextWebsiteProjectStatus(conversationId)
  if (!status.ready) {
    throw new Error(`Next.js/TSX preview cannot start until these required file(s) exist: ${status.missingFiles.join(', ')}`)
  }

  const previewDir = join(status.rootDir, '.agent-preview')
  const distDir = join(previewDir, 'dist')
  await rm(/* turbopackIgnore: true */ distDir, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })

  const pageImport = toPosixPath(relative(previewDir, join(status.rootDir, status.appDir, 'page.tsx')))
  const cssImport = toPosixPath(relative(previewDir, join(status.rootDir, status.appDir, 'globals.css')))
  const entryPath = join(previewDir, 'entry.tsx')
  await writeFile(/* turbopackIgnore: true */ entryPath, `
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Page from './${pageImport}'
import './${cssImport}'

function PreviewRoot() {
  const [asyncNode, setAsyncNode] = useState<React.ReactNode>(null)
  const [asyncError, setAsyncError] = useState<string | null>(null)
  const isAsyncPage = Page && Page.constructor && Page.constructor.name === 'AsyncFunction'

  useEffect(() => {
    if (!isAsyncPage) return
    Promise.resolve(Page({}))
      .then(setAsyncNode)
      .catch((err) => setAsyncError(err instanceof Error ? err.message : String(err)))
  }, [isAsyncPage])

  if (asyncError) {
    return <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}><h1>Preview render failed</h1><pre>{asyncError}</pre></main>
  }
  if (isAsyncPage) return <>{asyncNode}</>
  return <Page />
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PreviewRoot />
  </React.StrictMode>,
)
`, 'utf-8')

  try {
    const { build: esbuildBuild } = await import('esbuild')
    await esbuildBuild({
      entryPoints: [entryPath],
      outfile: join(distDir, 'preview.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: ['es2020'],
      nodePaths: [join(process.cwd(), 'node_modules')],
      jsx: 'automatic',
      logLevel: 'silent',
      sourcemap: false,
      loader: {
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.jpeg': 'dataurl',
        '.gif': 'dataurl',
        '.webp': 'dataurl',
        '.svg': 'dataurl',
      },
      plugins: [
        nextShimPlugin(),
        sandboxResolutionPlugin(status.rootDir, previewDir),
      ],
    })
  } catch (err) {
    throw new Error(`TSX preview build failed: ${conciseBuildErrors(err)}`)
  }

  await writeFile(/* turbopackIgnore: true */ join(previewDir, 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generated Website Preview</title>
    <link rel="stylesheet" href="/dist/preview.css" />
    <script type="module" src="/dist/preview.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`, 'utf-8')

  const server = await getOrStartPreviewServer(conversationId, previewDir)
  const cacheBuster = `v=${Date.now()}`
  return {
    url: `${server.origin}/?${cacheBuster}`,
    origin: server.origin,
    port: server.port,
    rootDir: status.rootDir,
    previewDir,
    appDir: status.appDir,
  }
}
