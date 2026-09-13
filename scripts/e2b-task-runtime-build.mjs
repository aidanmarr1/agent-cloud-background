#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Template, defaultBuildLogger, waitForFile } from 'e2b'
import { loadLocalEnvFiles } from './load-local-env.mjs'

loadLocalEnvFiles(new URL('../', import.meta.url))
const context = await mkdtemp(join(tmpdir(), 'agent-task-runtime-'))
try {
  // A dedicated allowlist excludes env files, git history, customer files,
  // attachments, local caches and QA output from the hosted template.
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
  const files = [...new Set([
    ...tracked.filter(path => path.startsWith('src/')),
    'src/lib/agent/taskRuntimeMode.ts', 'src/lib/agent/e2bTaskRuntime.ts', 'src/lib/agent/taskDispatchError.ts',
    'package.json', 'package-lock.json', 'tsconfig.json',
    'scripts/task-worker.mjs', 'scripts/load-local-env.mjs', 'scripts/e2b-task-runtime.mjs',
  ])].sort()
  const hash = createHash('sha256')
  for (const path of files) {
    const bytes = await readFile(path)
    hash.update(path).update('\0').update(bytes).update('\0')
    await mkdir(dirname(join(context, path)), { recursive: true })
    await writeFile(join(context, path), bytes)
  }
  const revision = hash.digest('hex')
  await writeFile(join(context, 'runtime-revision'), revision)
  const name = `agent-task-${revision.slice(0, 16)}`
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ name, revision, fileCount: files.length, cpuCount: 1, memoryMB: 2048,
      instruction: 'Pass --apply to build this isolated, secret-free runtime template.' }))
    process.exitCode = 0
  } else {
    if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required.')
    const template = Template({ fileContextPath: context }).fromNodeImage('22')
      .setUser('root').runCmd('id user >/dev/null 2>&1 || useradd -m -s /bin/bash user')
      .runCmd('mkdir -p /opt/agent && chown user:user /opt/agent')
      .copy(['package.json', 'package-lock.json'], '/opt/agent/').setWorkdir('/opt/agent')
      .runCmd('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund')
      .copy('.', '/opt/agent')
      .runCmd('chown -R user:user /opt/agent').setUser('user')
      .setStartCmd('touch /tmp/task-runtime-ready && sleep infinity', waitForFile('/tmp/task-runtime-ready'))
    const built = await Template.build(template, name, {
      apiKey: process.env.E2B_API_KEY, cpuCount: 1, memoryMB: 2048,
      onBuildLogs: defaultBuildLogger(),
    })
    const result = { template: built.templateId, name, buildId: built.buildId, revision }
    await mkdir('.agent-runtime', { recursive: true })
    await writeFile('.agent-runtime/e2b-task-runtime-build.json', JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  }
} finally {
  await rm(context, { recursive: true, force: true })
}
