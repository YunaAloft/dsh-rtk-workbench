#!/usr/bin/env node
// Repository-owned packaging checks for a DSH plugin bundle.
//
// Scope: the requirements that the official DSH documentation puts on a plugin
// package — manifest fields, the bundle patch (parsed as YAML), engine range,
// peer dependencies (cross-checked against the built entry's imports), the
// files whitelist, and the 0.2 display metadata (locale meta + exported icon).
//
// It is a *copyable template*: no plugin-specific paths. The entry comes from
// package.json#main, the patch from dsh.bundle.patch, locales from locale/*.json,
// the icon from exports["./icon"]. Run it after the build so lib/ exists.
//
// Deliberately not covered: contributor preferences (README language count,
// wording). See templates/plugin-checks/README.md for the full contract.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, normalize } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = process.argv[2] ?? process.cwd()
const passed = []
const failed = []

/** Record one assertion under its human-readable label. */
function check(condition, label) {
  ;(condition ? passed : failed).push(label)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
} catch (error) {
  console.error(`manifest-check: cannot read package.json: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

check(typeof pkg.name === 'string' && pkg.name !== '', 'package.json declares a name')
check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), 'package.json declares a semver version')
check(pkg.type === 'module' || pkg.type === 'commonjs' || pkg.type === undefined, 'package.json type is valid')
check(typeof pkg.main === 'string' && existsSync(join(root, pkg.main)), 'main entry exists')
check(pkg.dsh?.manifestVersion === 1, 'dsh.manifestVersion is 1')
check(typeof pkg.exports?.['.'] === 'string', 'exports["."] is declared')
check(typeof pkg.exports?.['./icon'] === 'string', 'exports["./icon"] is declared')
check(typeof pkg.exports?.['./locale/*.json'] === 'string', 'exports for locale files are declared')

const rawPatch = pkg.dsh?.bundle?.patch
const patches = typeof rawPatch === 'string' ? [rawPatch] : Array.isArray(rawPatch) ? rawPatch : []
check(patches.length > 0, 'dsh.bundle.patch is declared')
for (const patch of patches) {
  const path = join(root, patch)
  if (!existsSync(path)) {
    check(false, `bundle patch exists (${patch})`)
    continue
  }
  check(true, `bundle patch exists (${patch})`)
  let parsed
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'))
  } catch (error) {
    check(false, `bundle patch parses as YAML (${error instanceof Error ? error.message : String(error)})`)
    continue
  }
  check(true, 'bundle patch parses as YAML')
  check(Array.isArray(parsed) && parsed.length > 0, 'bundle patch is a non-empty YAML array')

  const ids = []
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    check(entry !== null && typeof entry === 'object' && !Array.isArray(entry), 'bundle patch rows are objects')
    const verbs = entry !== null && typeof entry === 'object' ? Object.keys(entry) : []
    check(
      verbs.some((verb) => ['insert', 'remove', 'replace'].includes(verb)),
      'bundle patch row declares a verb (insert/remove/replace)',
    )
    if (Array.isArray(entry?.insert)) {
      for (const row of entry.insert) {
        check(typeof row?.id === 'string' && row.id !== '', 'insert row declares an id')
        check(typeof row?.name === 'string' && row.name !== '', 'insert row declares a name')
        if (typeof row?.id === 'string') ids.push(row.id)
      }
    }
  }
  check(ids.length > 0, 'bundle patch declares at least one insert row')
  check(new Set(ids).size === ids.length, 'bundle patch row ids are unique')
}

check(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh !== '', 'engines.dsh is declared')
check(typeof pkg.engines?.node === 'string' && pkg.engines.node !== '', 'engines.node is declared')
if (pkg.packageManager !== undefined) {
  check(
    typeof pkg.packageManager === 'string' && /^[a-z]+@\d+\.\d+\.\d+/.test(pkg.packageManager),
    'packageManager pins an exact package-manager version',
  )
}

const peers = pkg.peerDependencies ?? {}
check(Object.keys(peers).some((name) => name.startsWith('@deepseek-ai/')), 'peerDependencies declare harness packages')
check(pkg.peerDependenciesMeta !== undefined, 'peerDependenciesMeta marks the peers optional')

// The bundle is what users run: every harness package it imports at runtime
// must be a peer (or a dependency). Type-only imports are erased by the build,
// so scanning the built entry avoids false positives.
const libEntry = typeof pkg.main === 'string' ? join(root, pkg.main) : null
if (libEntry && existsSync(libEntry)) {
  const code = readFileSync(libEntry, 'utf8')
  const imported = new Set([...code.matchAll(/from\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map((match) => match[1]))
  for (const name of imported) {
    check(
      Object.hasOwn(peers, name) || Object.hasOwn(pkg.dependencies ?? {}, name),
      `peerDependencies cover built import ${name}`,
    )
  }
} else {
  check(false, 'built entry exists for peer/import alignment')
}

const files = Array.isArray(pkg.files) ? pkg.files.map((entry) => normalize(entry)) : []
const mainDir = typeof pkg.main === 'string' && pkg.main.includes('/') ? normalize(pkg.main.split('/')[0]) : ''
if (mainDir !== '') check(files.includes(mainDir), `files whitelist ships the built entry directory (${mainDir})`)
for (const patch of patches) check(files.includes(normalize(basename(patch))), `files whitelist ships the bundle patch (${basename(patch)})`)
check(files.some((entry) => entry.includes('locale')), 'files whitelist ships locale metadata')
const iconExport = pkg.exports?.['./icon']
const iconRel = typeof iconExport === 'string' ? iconExport.replace(/^\.\//, '') : 'icon.svg'
check(files.some((entry) => entry.includes('icon')), 'files whitelist ships the icon')
check(existsSync(join(root, 'README.md')), 'README.md exists')
for (const entry of files) {
  if (entry.includes('*')) continue
  check(existsSync(join(root, entry)), `files entry exists (${entry})`)
}

const localeDir = join(root, 'locale')
const localeFiles = existsSync(localeDir) ? readdirSync(localeDir).filter((name) => name.endsWith('.json')) : []
check(localeFiles.length > 0, 'locale/*.json display metadata exists')
for (const name of localeFiles) {
  const path = join(localeDir, name)
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8')).meta ?? {}
    check(typeof meta.title === 'string' && meta.title !== '', `locale/${name} has meta.title`)
    check(typeof meta.description === 'string' && meta.description !== '', `locale/${name} has meta.description`)
  } catch {
    check(false, `locale/${name} parses as JSON`)
  }
}

const iconPath = join(root, iconRel)
if (existsSync(iconPath)) {
  check(statSync(iconPath).size <= 256 * 1024, `${iconRel} is at most 256 KiB`)
} else {
  check(false, `${iconRel} exists`)
}

for (const label of passed) console.log(`✓ ${label}`)
for (const label of failed) console.error(`✗ ${label}`)
if (failed.length > 0) {
  console.error(`manifest-check: ${failed.length} failure(s)`)
  process.exit(1)
}
console.log(`manifest-check: ok — ${passed.length} checks`)
