#!/usr/bin/env node
/**
 * Publish the plugin and its bundled-rtk artifacts.
 *
 * Order matters: the five platform sub-packages must exist on the registry
 * before the main package, or every install resolves zero optional dependencies
 * and silently falls back to PATH.
 *
 * Usage:
 *   node scripts/release.mjs --dry-run          # show the full plan
 *   node scripts/release.mjs --yes              # publish to npm
 *   node scripts/release.mjs --yes --skip-npm   # only prepare GitHub assets
 *   node scripts/release.mjs --yes --registry https://registry.npmjs.org
 *   node scripts/release.mjs --yes --no-verify  # publish without polling the registry
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { PLATFORMS, platformDependencies, platformPackageName } from './platforms.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_NPM = join(ROOT, 'dist', 'npm')
const DIST_GH = join(ROOT, 'dist', 'github')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run') || !argv.includes('--yes')
const skipNpm = argv.includes('--skip-npm')
const registryIndex = argv.indexOf('--registry')
const registry = registryIndex === -1 ? undefined : argv[registryIndex + 1]

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = manifest.version
const rtkVersion = manifest.dshRtkVersion
const platforms = PLATFORMS.map((platform) => platform.id)

/** Run one command, inheriting stdio, and fail loudly. */
function run(command, args, options = {}) {
  const needsShell = process.platform === 'win32' && command === 'npm'
  const result = spawnSync(command, args, { stdio: 'inherit', shell: needsShell, cwd: ROOT, ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`)
}

/** Print the plan and, unless dry-running, execute it. */
function publish(tarball, label) {
  if (!existsSync(tarball)) throw new Error(`missing artifact ${tarball}; run \`node scripts/build-vendor.mjs\``)
  const args = ['publish', tarball, '--access', 'public']
  if (registry !== undefined) args.push('--registry', registry)
  if (dryRun) args.push('--dry-run')
  console.log(`${dryRun ? '[dry-run] ' : ''}${label}: npm ${args.join(' ')}`)
  run('npm', args)
}

if (skipNpm) {
  console.log('npm publishing skipped')
} else {
  if (!existsSync(DIST_NPM)) throw new Error('dist/npm is missing; run `node scripts/build-vendor.mjs` first')
  for (const platform of platforms) {
    const tarball = join(DIST_NPM, `${platformPackageName(platform)}-${version}.tgz`)
    publish(tarball, platformPackageName(platform))
  }
  // Pack the main package last, after the platform packages exist on the
  // registry. The repository's package.json carries no `optionalDependencies` —
  // an unpublished name would make `pnpm install --frozen-lockfile` fail — so
  // they are injected into the packed manifest only, then the file is restored.
  const manifestPath = join(ROOT, 'package.json')
  const original = readFileSync(manifestPath, 'utf8')
  const packed = (() => {
    try {
      const withBins = JSON.parse(original)
      withBins.optionalDependencies = platformDependencies(version)
      writeFileSync(manifestPath, `${JSON.stringify(withBins, null, 2)}\n`)
      return spawnSync('pnpm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
    } finally {
      writeFileSync(manifestPath, original)
    }
  })()
  if (packed.status !== 0) throw new Error(`pnpm pack failed: ${packed.stderr ?? ''}`)
  const name = packed.stdout.trim().split('\n').pop()
  if (name === undefined || name === '') throw new Error('pnpm pack printed no filename')
  publish(join(ROOT, name), `dsh-rtk-workbench@${version}`)
}

// A successful `npm publish` does not mean the version is installable: a brand
// new package is accepted with HTTP 202 and served as the placeholder
// `0.0.0-stage` until its staged release is approved. Poll until every package
// really serves the version, so a green script is not a green registry.
const verifyDisabled = argv.includes('--no-verify')
const verifyRegistry = registry ?? 'https://registry.npmjs.org'
const VERIFY_TIMEOUT_MS = 15 * 60 * 1000
const VERIFY_INTERVAL_MS = 20_000

/** The version currently served as `latest` for one package, or undefined. */
function liveVersion(pkg) {
  const args = ['view', pkg, 'version', '--registry', verifyRegistry]
  const result = spawnSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.status !== 0) return undefined
  const text = (result.stdout ?? '').trim()
  return text === '' ? undefined : text
}

async function verifyPublication() {
  const pending = new Set([...platforms.map((id) => platformPackageName(id)), 'dsh-rtk-workbench'])
  const deadline = Date.now() + VERIFY_TIMEOUT_MS
  console.log('')
  console.log('verifying npm publication — new packages are staged for review, this can take a while')
  for (;;) {
    for (const pkg of [...pending]) {
      const live = liveVersion(pkg)
      if (live === version) {
        pending.delete(pkg)
        console.log(`  live     ${pkg} ${version}`)
      } else if (live === '0.0.0-stage') {
        console.log(`  staged   ${pkg} — awaiting approval`)
      } else {
        console.log(`  pending  ${pkg} — ${live ?? 'not found'}`)
      }
    }
    if (pending.size === 0) {
      console.log('all six packages are live on the registry')
      return
    }
    if (Date.now() >= deadline) {
      console.error(`still not live after 15 minutes: ${[...pending].join(', ')}`)
      process.exitCode = 1
      return
    }
    await new Promise((done) => setTimeout(done, VERIFY_INTERVAL_MS))
  }
}

if (!skipNpm && !dryRun && !verifyDisabled) await verifyPublication()

const githubAssets = existsSync(DIST_GH) ? readdirSync(DIST_GH).filter((file) => file.endsWith('.tgz') || file === 'checksums.txt' || file === 'manifest.json') : []
console.log('')
console.log(`GitHub release assets (${String(githubAssets.length)} files) in dist/github:`)
for (const asset of githubAssets) console.log(`  ${asset}`)
console.log('')
console.log('Publish them with:')
console.log(`  gh release create v${version} dist/github/*.tgz dist/github/checksums.txt dist/github/manifest.json \\`)
console.log(`    --title "dsh-rtk-workbench v${version} (rtk ${rtkVersion})" --generate-notes`)
console.log('')
console.log('Users then install with either:')
console.log(`  dsh plugin --profile <name> add dsh-rtk-workbench`)
console.log(`  dsh plugin --profile <name> add https://github.com/<owner>/dsh-rtk-workbench/releases/latest/download/dsh-rtk-workbench-<platform>.tgz`)
if (dryRun) console.log('\n(dry run — pass --yes to publish for real)')
