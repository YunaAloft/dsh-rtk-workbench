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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
const platforms = Object.keys(manifest.optionalDependencies ?? {}).map((name) => (name.split('/').pop() ?? '').replace(/^rtk-/, ''))

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
    const tarball = join(DIST_NPM, `dsh-rtk-workbench-rtk-${platform}-${rtkVersion}.tgz`)
    publish(tarball, `@dsh-rtk-workbench/rtk-${platform}`)
  }
  // Pack the main package last, after the platform packages exist on the registry.
  const packed = spawnSync('pnpm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
  if (packed.status !== 0) throw new Error(`pnpm pack failed: ${packed.stderr ?? ''}`)
  const name = packed.stdout.trim().split('\n').pop()
  if (name === undefined || name === '') throw new Error('pnpm pack printed no filename')
  publish(join(ROOT, name), `dsh-rtk-workbench@${version}`)
}

const githubAssets = existsSync(DIST_GH) ? readdirSync(DIST_GH).filter((file) => file.endsWith('.tgz') || file === 'checksums.txt' || file === 'manifest.json') : []
console.log('')
console.log(`GitHub release assets (${String(githubAssets.length)} files) in dist/github:`)
for (const asset of githubAssets) console.log(`  ${asset}`)
console.log('')
console.log('Publish them with:')
console.log(`  gh release create v${version} dist/github/*.tgz dist/github/checksums.txt dist/github/manifest.json \\`)
console.log(`    --title "dsh-rtk-workbench v${version} (rtk ${rtkVersion})" --notes-file CHANGELOG.md`)
console.log('')
console.log('Users then install with either:')
console.log(`  dsh plugin --profile <name> add dsh-rtk-workbench`)
console.log(`  dsh plugin --profile <name> add https://github.com/<owner>/dsh-rtk-workbench/releases/download/v${version}/dsh-rtk-workbench-${version}-<platform>.tgz`)
if (dryRun) console.log('\n(dry run — pass --yes to publish for real)')
