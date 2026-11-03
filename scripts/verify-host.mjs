#!/usr/bin/env node
/**
 * Compatibility ledger helper.
 *
 * Reads this package's manifest, checks `engines.dsh` and every
 * `@deepseek-ai/dsh*` peer range against one host version, prints a Markdown
 * ledger row for `docs/compatibility.md`, and exits non-zero on a mismatch.
 *
 * Usage:
 *   node scripts/verify-host.mjs                  # detect the installed host
 *   node scripts/verify-host.mjs --host-version 0.2.1-rc.5
 *   node scripts/verify-host.mjs --self-test      # exercise the range matcher
 *
 * Host detection order: `--host-version`, `DSH_HOST_VERSION`,
 * `DSH_INSTALL_PACKAGE_JSON`, then `require.resolve('@deepseek-ai/dsh')`.
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Parse `1.2.3` / `1.2.3-rc.1` into comparable parts. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text ?? '').trim())
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/** Compare two parsed versions; prereleases sort before the release. */
function compare(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)
    if (a === b) continue
    if (numeric) return Number(a) < Number(b) ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

/** One comparator (`>=1.2.3`, `<2.0.0`, `1.2.3`). */
function testComparator(version, token) {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  if (match === null) return false
  const operator = match[1] ?? '='
  const target = parseVersion(match[2])
  if (target === undefined) return false
  const order = compare(version, target)
  switch (operator) {
    case '>=':
      return order >= 0
    case '<=':
      return order <= 0
    case '>':
      return order > 0
    case '<':
      return order < 0
    case '=':
      return order === 0
    default:
      return false
  }
}

/** Whether `version` satisfies a semver range (comparators, `||`, spaces). */
export function satisfies(versionText, rangeText) {
  const version = parseVersion(versionText)
  if (version === undefined) return false
  return String(rangeText)
    .split('||')
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative !== '')
    .some((alternative) =>
      alternative
        .split(/\s+/)
        .filter((token) => token !== '')
        .every((token) => testComparator(version, token)),
    )
}

/** Read the installed host's version, when it can be resolved. */
function detectHostVersion() {
  const override = process.env.DSH_INSTALL_PACKAGE_JSON
  if (override !== undefined && override.trim() !== '') {
    try {
      return JSON.parse(readFileSync(override, 'utf8')).version
    } catch {
      /* fall through */
    }
  }
  try {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version
  } catch {
    /* fall through to the CLI */
  }
  const attempts =
    process.platform === 'win32'
      ? [[process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'dsh --version']]]
      : [['dsh', ['--version']]]
  for (const [command, args] of attempts) {
    try {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 })
      const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(result.stdout ?? ''))
      if (match?.[1] !== undefined) return match[1]
    } catch {
      /* try the next spelling */
    }
  }
  return undefined
}

const SELF_TEST = [
  ['0.2.1-rc.5', '>=0.2.0-0 <0.3.0', true],
  ['0.2.0', '>=0.2.0-0 <0.3.0', true],
  ['0.2.0-rc.1', '>=0.2.0-0 <0.3.0', true],
  ['0.3.0', '>=0.2.0-0 <0.3.0', false],
  ['0.1.9', '>=0.2.0-0 <0.3.0', false],
  ['0.2.1', '>0.2.0', true],
  ['0.2.0', '>0.2.0', false],
  ['0.2.1-rc.5', '<=0.2.1-rc.5', true],
  ['0.2.1-rc.6', '<0.2.1-rc.5', false],
  ['0.2.1-rc.5', '>=0.1.2-rc.1 <0.2.0 || >=0.2.0-0 <0.3.0', true],
  ['1.0.0', '>=0.1.2-rc.1 <0.3.0', false],
]

/** Run the range matcher against fixed cases. */
function selfTest() {
  let failed = 0
  for (const [version, range, expected] of SELF_TEST) {
    const actual = satisfies(version, range)
    if (actual !== expected) {
      console.error(`FAIL ${version} in ${range}: expected ${expected}, got ${actual}`)
      failed += 1
    }
  }
  if (failed === 0) console.log(`verify-host self-test: ${SELF_TEST.length} cases pass`)
  process.exit(failed === 0 ? 0 : 1)
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/verify-host.mjs [--host-version <version>] [--self-test]')
  process.exit(0)
}
if (argv.includes('--self-test')) selfTest()

const explicit = argv.indexOf('--host-version')
const hostVersion =
  (explicit === -1 ? undefined : argv[explicit + 1]) ??
  (process.env.DSH_HOST_VERSION?.trim() || undefined) ??
  detectHostVersion()

if (hostVersion === undefined) {
  console.error(
    'verify-host: cannot determine the host version. Pass --host-version <version> or set DSH_HOST_VERSION.',
  )
  process.exit(2)
}

const checks = []
const engineRange = MANIFEST.engines?.dsh
if (typeof engineRange === 'string') checks.push(['engines.dsh', engineRange])
for (const [name, range] of Object.entries(MANIFEST.peerDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh') && typeof range === 'string') checks.push([name, range])
}
if (checks.length === 0) {
  console.error('verify-host: package.json declares no engines.dsh or @deepseek-ai/dsh* peer ranges')
  process.exit(2)
}

let mismatches = 0
for (const [name, range] of checks) {
  const ok = satisfies(hostVersion, range)
  if (!ok) mismatches += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${hostVersion} in ${range}`)
}

const today = new Date().toISOString().slice(0, 10)
const rtk = MANIFEST.dshRtkVersion ?? 'unknown'
console.log('')
console.log(`Ledger row: | \`${hostVersion}\` | \`${rtk}\` | ${today} | \`node scripts/verify-host.mjs\` | |`)

if (mismatches > 0) {
  console.error(`verify-host: ${mismatches} range(s) do not accept ${hostVersion}`)
  process.exit(1)
}
