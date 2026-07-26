#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const runtimeRoot = join(root, 'sandbox-runtime')
const commandNames = [
  'agent-render-diagram',
  'agent-md-to-pdf',
  'agent-speech-to-text',
  'agent-analyze-video',
  'agent-upload-file',
  'agent-sandbox-info',
  'agent-scaffold-web',
]

const [
  dockerfile,
  buildScript,
  docs,
  manifestBody,
  requirements,
  diagramCommand,
  pdfCommand,
  speechCommand,
  uploadCommand,
  videoCommand,
  initCommand,
  supervisorConfig,
  templatePackage,
  templateCss,
  rootTsconfigBody,
] = await Promise.all([
  readFile(join(root, 'e2b.Dockerfile'), 'utf8'),
  readFile(join(root, 'scripts/e2b-template-build-v2.mjs'), 'utf8'),
  readFile(join(root, 'docs/sandbox-runtime.md'), 'utf8'),
  readFile(join(runtimeRoot, 'runtime-manifest.json'), 'utf8'),
  readFile(join(runtimeRoot, 'python-requirements.txt'), 'utf8'),
  readFile(join(runtimeRoot, 'bin/agent-render-diagram'), 'utf8'),
  readFile(join(runtimeRoot, 'bin/agent-md-to-pdf'), 'utf8'),
  readFile(join(runtimeRoot, 'bin/agent-speech-to-text'), 'utf8'),
  readFile(join(runtimeRoot, 'bin/agent-upload-file'), 'utf8'),
  readFile(join(runtimeRoot, 'bin/agent-analyze-video'), 'utf8'),
  readFile(join(runtimeRoot, 'bin/agent-sandbox-init'), 'utf8'),
  readFile(join(runtimeRoot, 'config/supervisord.conf'), 'utf8'),
  readFile(join(runtimeRoot, 'templates/web-static/package.json'), 'utf8'),
  readFile(join(runtimeRoot, 'templates/web-static/src/styles.css'), 'utf8'),
  readFile(join(root, 'tsconfig.json'), 'utf8'),
])

const manifest = JSON.parse(manifestBody)
assert.equal(manifest.profile, 'agent-parity-v1')
assert.equal(manifest.resourceTarget.cpuCount, 6)
assert.equal(manifest.resourceTarget.memoryMB, 4096)
assert.deepEqual(manifest.firstPartyCommands.slice(0, 5), commandNames.slice(0, 5))
assert.equal(manifest.environment.HOME, '/home/user')
assert.equal(manifest.environment.USER, 'user')
assert.equal(manifest.environment.SHELL, '/bin/bash')

assert.match(dockerfile, /^FROM python:3\.12-slim-bookworm/m)
assert.match(dockerfile, /ARG NODE_VERSION=22\.13\.0/)
assert.match(dockerfile, /msopenjdk-21/)
assert.match(dockerfile, /default-mysql-client/)
assert.match(dockerfile, /\bffmpeg\b/)
assert.match(dockerfile, /\bsocat\b/)
assert.match(dockerfile, /\brclone\b/)
assert.match(dockerfile, /@googleworkspace\/cli@0\.22\.3/)
assert.match(dockerfile, /pnpm@11\.17\.0/)
assert.match(dockerfile, /yarn@1\.22\.22/)
assert.match(dockerfile, /typst-x86_64-unknown-linux-musl/)
assert.match(dockerfile, /d2-v\$\{D2_VERSION\}-linux-amd64/)
assert.match(dockerfile, /ggml-base\.en\.bin/)
assert.match(dockerfile, /sha1sum --check/)
assert.match(dockerfile, /supervisor/)
assert.match(dockerfile, /xvfb/)
assert.match(dockerfile, /DISPLAY=:0/)
assert.match(dockerfile, /ENV HOME=\/home\/user/)
assert.match(dockerfile, /ENV USER=user/)
assert.match(dockerfile, /ENV SHELL=\/bin\/bash/)
assert.match(dockerfile, /WEBDEV_TEMPLATES_PATH=\/opt\/agent\/webdev\/templates/)
assert.match(dockerfile, /COPY bin\//)
assert.doesNotMatch(dockerfile, /\b(?:rustc|golang|ruby|docker\.io)\b/)

for (const moduleName of ['beautifulsoup4', 'fastapi', 'matplotlib', 'numpy', 'openai', 'pandas', 'playwright', 'pydantic']) {
  assert.match(requirements, new RegExp(`^${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'))
}

assert.match(buildScript, /Template\(\{ fileContextPath: join\(root, 'sandbox-runtime'\) \}\)/)
assert.match(buildScript, /application source,[\s\S]*not part of the third-party E2B build context/, 'template builds must not upload the application repository as build context')
assert.match(buildScript, /waitForFile\('\/tmp\/agent-sandbox-ready'\)/)
assert.match(buildScript, /E2B_TEMPLATE_BUILD_CPU'\) \|\| '6'/)
assert.match(buildScript, /E2B_TEMPLATE_BUILD_MEMORY_MB'\) \|\| '4096'/)

assert.match(uploadCommand, /AGENT_UPLOAD_ENDPOINT/)
assert.match(uploadCommand, /parsed_endpoint\.scheme != "https"/)
assert.match(uploadCommand, /agent-artifact:\/\//)
assert.doesNotMatch(uploadCommand, /add_argument\(\s*["']--endpoint/)
assert.doesNotMatch(uploadCommand, /args\.endpoint/)
assert.match(uploadCommand, /configured first-party upload endpoint rejected the file/)
assert.match(diagramCommand, /command_path\("mmdc"\)/)
assert.match(diagramCommand, /command_path\("d2"\)/)
assert.match(diagramCommand, /command_path\("plantuml"\)/)
assert.match(pdfCommand, /default-src 'none'/)
assert.match(pdfCommand, /scriptEnabled=false/)
assert.match(speechCommand, /command_path\("whisper-cli"\)/)
assert.match(speechCommand, /command_path\("ffmpeg"\)/)
assert.match(videoCommand, /AGENT_VISION_API_KEY/)
assert.match(videoCommand, /agent-speech-to-text/)
assert.match(videoCommand, /sampled frames/i)
assert.doesNotMatch(videoCommand, /Vision analysis failed:\s*\{error\}/)
assert.doesNotMatch(videoCommand, /local evidence report only:\s*\{error\}/)
assert.match(initCommand, /supervisord -c \/etc\/agent\/supervisord\.conf/)
assert.match(initCommand, /xdpyinfo/)
assert.match(supervisorConfig, /Xvfb :0 -screen 0 1440x900x24/)
assert.match(supervisorConfig, /autorestart=true/)
assert.doesNotMatch(`${dockerfile}\n${uploadCommand}\n${videoCommand}`, /manus-(?:render|md|speech|analyze|upload)/i)

const parsedTemplatePackage = JSON.parse(templatePackage)
assert.equal(parsedTemplatePackage.dependencies.react.startsWith('^19.'), true)
assert.ok(parsedTemplatePackage.devDependencies.tailwindcss)
assert.doesNotMatch(templateCss, /gradient\s*\(/i)
assert.ok(
  JSON.parse(rootTsconfigBody).exclude.includes('sandbox-runtime/templates/**'),
  'the standalone scaffold must not be type-checked against the host app dependencies',
)

assert.match(docs, /provider-controlled/i)
assert.match(docs, /agent-render-diagram/)
assert.match(docs, /agent-upload-file/)
assert.match(docs, /does\s+not bake credentials/i)
assert.match(docs, /npm run e2b:template:build/)

for (const name of commandNames) {
  const commandPath = join(runtimeRoot, 'bin', name)
  const result = spawnSync('python3', [commandPath, '--help'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, `${name} --help failed: ${result.stderr}`)
  assert.match(result.stdout, /usage:/i, `${name} must expose command help`)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'agent-sandbox-contract-'))
try {
  const stagedSource = join(tempRoot, 'artifact.txt')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(stagedSource, 'artifact\n'))
  const uploadResult = spawnSync(
    'python3',
    [join(runtimeRoot, 'bin/agent-upload-file'), stagedSource, '--json'],
    {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_WORKSPACE: tempRoot,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  )
  assert.equal(uploadResult.status, 0, uploadResult.stderr)
  const uploadPayload = JSON.parse(uploadResult.stdout)
  assert.equal(uploadPayload.public, false)
  assert.match(uploadPayload.artifactUri, /^agent-artifact:\/\/agent-exports\//)
  assert.equal((await stat(uploadPayload.path)).size, 9)

  const publicUploadResult = spawnSync(
    'python3',
    [join(runtimeRoot, 'bin/agent-upload-file'), stagedSource, '--public'],
    {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_WORKSPACE: tempRoot,
        AGENT_UPLOAD_ENDPOINT: '',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  )
  assert.equal(publicUploadResult.status, 2)
  assert.match(publicUploadResult.stderr, /requires an operator-configured AGENT_UPLOAD_ENDPOINT/)

  const scaffoldPath = join(tempRoot, 'web')
  const scaffoldResult = spawnSync(
    'python3',
    [join(runtimeRoot, 'bin/agent-scaffold-web'), scaffoldPath],
    {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        WEBDEV_TEMPLATES_PATH: join(runtimeRoot, 'templates'),
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  )
  assert.equal(scaffoldResult.status, 0, scaffoldResult.stderr)
  assert.equal((await stat(join(scaffoldPath, 'src/App.tsx'))).isFile(), true)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

console.log('Sandbox runtime contract smoke passed.')
