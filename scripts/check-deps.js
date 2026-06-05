#!/usr/bin/env node

/**
 * Pre-dev dependency integrity check.
 *
 * Default path:
 * 1. Check a known list of critical packages for expected files/directories
 *
 * Optional path:
 * 2. Set CHECK_DEPS_DEEP_SCAN=1 to scan packages whose index.js references
 *    ./lib/ or ./src/ but the dir is missing. This can be slow on large
 *    node_modules trees, so normal dev startup keeps it disabled.
 *
 * If any are broken (e.g. from npm install racing with Turbopack),
 * removes them and runs npm install to restore them.
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const projectRoot = path.join(__dirname, '..')
const nmDir = path.join(projectRoot, 'node_modules')
const broken = new Set()
const deepScan = process.env.CHECK_DEPS_DEEP_SCAN === '1'

function resetDevCacheIfPoisoned() {
  const nextDir = path.join(projectRoot, '.next')
  const devLog = path.join(nextDir, 'dev', 'logs', 'next-development.log')
  if (!fs.existsSync(devLog)) return

  let log = ''
  try {
    log = fs.readFileSync(devLog, 'utf8')
  } catch {
    return
  }

  const poisonPatterns = [
    'ETIMEDOUT: connection timed out, read',
    'Invalid package config',
    'Cannot read file',
    '[webpack.cache.PackFileCacheStrategy] Restoring pack failed',
    '[webpack.cache.PackFileCacheStrategy] Caching failed',
  ]

  if (!poisonPatterns.some((pattern) => log.includes(pattern))) return

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const quarantine = path.join('/private/tmp', `agent-next-cache-poisoned-${stamp}`)

  try {
    fs.renameSync(nextDir, quarantine)
    console.error(`\x1b[33m⚠ Cleared poisoned Next dev cache: moved .next to ${quarantine}\x1b[0m`)
  } catch {
    fs.rmSync(nextDir, { recursive: true, force: true })
    console.error('\x1b[33m⚠ Cleared poisoned Next dev cache: removed .next\x1b[0m')
  }
}

resetDevCacheIfPoisoned()

// Pass 1: Known critical packages
const CHECKS = [
  { pkg: 'postcss', required: 'lib' },
  { pkg: 'highlight.js', required: 'lib' },
  { pkg: 'property-information', required: 'lib' },
  { pkg: 'lucide-react', required: 'dist' },
  { pkg: 'react-markdown', required: 'lib' },
  { pkg: 'jsdom', required: 'lib' },
  { pkg: 'eslint-scope', required: 'lib' },
  { pkg: 'eslint-visitor-keys', required: 'lib' },
  { pkg: 'katex', required: 'dist' },
  { pkg: 'next', required: 'dist' },
  { pkg: '@next/swc-darwin-arm64', required: 'next-swc.darwin-arm64.node' },
  { pkg: 'd3-sankey', required: 'src' },
]

for (const { pkg, required } of CHECKS) {
  const pkgDir = path.join(nmDir, pkg)
  const requiredPath = path.join(pkgDir, required)
  if (fs.existsSync(pkgDir) && !fs.existsSync(requiredPath)) {
    broken.add(pkg)
  }
}

// Pass 2: Scan all packages for index.js referencing ./lib/ or ./src/ without the directory
function scanPackages(dir) {
  let entries
  try { entries = fs.readdirSync(dir) } catch { return }

  for (const name of entries) {
    if (name.startsWith('.')) continue
    const fullPath = path.join(dir, name)

    if (name.startsWith('@')) {
      scanPackages(fullPath)
      continue
    }

    const indexPath = path.join(fullPath, 'index.js')
    if (!fs.existsSync(indexPath)) continue

    try {
      const content = fs.readFileSync(indexPath, 'utf8')
      if (content.includes("from './lib/") || content.includes("require('./lib/")) {
        if (!fs.existsSync(path.join(fullPath, 'lib'))) {
          const rel = path.relative(nmDir, fullPath)
          broken.add(rel)
        }
      }
      if (content.includes("from './src/")) {
        if (!fs.existsSync(path.join(fullPath, 'src'))) {
          const rel = path.relative(nmDir, fullPath)
          broken.add(rel)
        }
      }
    } catch { /* skip unreadable */ }
  }
}

if (deepScan) {
  scanPackages(nmDir)
}

if (broken.size === 0) {
  process.exit(0)
}

const list = [...broken]
console.error(`\x1b[33m⚠ Found ${list.length} corrupted package(s): ${list.join(', ')}\x1b[0m`)
console.error('\x1b[33m  Reinstalling to fix...\x1b[0m')

for (const pkg of list) {
  const pkgDir = path.join(nmDir, pkg)
  fs.rmSync(pkgDir, { recursive: true, force: true })
}

try {
  execSync('npm install', { stdio: 'inherit', cwd: projectRoot })
  console.error('\x1b[32m✓ Dependencies restored.\x1b[0m')
} catch (e) {
  console.error('\x1b[31m✗ npm install failed. Run it manually.\x1b[0m')
  process.exit(1)
}
