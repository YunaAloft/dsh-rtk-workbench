#!/usr/bin/env node
/**
 * Smoke the packed npm tarball without a running host.
 *
 * What it proves, in order: the tarball carries the files `package.json` claims,
 * the host half loads under plain Node with the expected plugin surface and
 * config defaults, the browser half registers itself with the page module table,
 * and the bundled binary for this platform is present and executable.
 *
 * It is deliberately host-free: installing a tarball into a throwaway profile is
 * the stronger check but needs the harness, while a broken `files` list, a stale
 * `lib/` or a missing vendor directory is already caught here.
 *
 * Usage: node scripts/smoke-pack.mjs <tarball.tgz>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tarball = process.argv[2]
if (tarball === undefined) {
  console.error('usage: node scripts/smoke-pack.mjs <tarball.tgz>')
  process.exit(1)
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const archive = resolve(tarball)
if (!existsSync(archive)) {
  console.error(`smoke-pack: ${archive} does not exist — run \`pnpm pack\` first`)
  process.exit(1)
}

const directory = mkdtempSync(join(tmpdir(), 'rtk-workbench-pack-'))
const failures = []
const pass = (label) => console.log(`✓ ${label}`)
const check = (condition, label) => {
  if (condition) pass(label)
  else failures.push(label)
}

try {
  execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' })
  const root = join(directory, 'package')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  check(manifest.name === 'dsh-rtk-workbench', 'package name is dsh-rtk-workbench')
  check(typeof manifest.version === 'string', 'package version present')
  check(manifest.exports?.['./client'] === './lib/client.js', 'exports ./client points at lib/client.js')
  check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform is web')
  check(existsSync(join(root, 'lib/index.js')), 'lib/index.js is packed')
  check(existsSync(join(root, 'lib/index.d.ts')), 'lib/index.d.ts is packed')
  check(existsSync(join(root, 'lib/client.js')), 'lib/client.js is packed')
  check(existsSync(join(root, 'cordis.patch.yml')), 'cordis.patch.yml is packed')
  check(existsSync(join(root, 'locale/zh.json')), 'locale/zh.json is packed')

  // Documentation ships with the package: the README links to these documents,
  // and a release asset that quietly drops them ships dead links.
  for (const relative of [
    'docs/reference.md',
    'docs/reference.zh.md',
    'docs/benchmark.md',
    'docs/benchmark.zh.md',
    'docs/compatibility.md',
    'docs/compatibility.zh.md',
    'CHANGELOG.md',
    'README.en.md',
  ]) {
    check(existsSync(join(root, relative)), `${relative} is packed`)
  }

  // The host half imports its peer dependency (`@deepseek-ai/schemastery`) as a
  // bare specifier; a profile provides it. Outside a profile we link the copy the
  // repository installed, which is exactly what the host would resolve.
  const peer = join(repoRoot, 'node_modules', '@deepseek-ai', 'schemastery')
  if (existsSync(peer)) {
    mkdirSync(join(directory, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(peer, join(directory, 'node_modules', '@deepseek-ai', 'schemastery'), 'junction')
  }

  // The host half must import cleanly outside the workspace.
  const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  check(host.name === 'dsh-rtk-workbench', 'host half exports name')
  check(typeof host.apply === 'function', 'host half exports apply')
  check(Array.isArray(host.inject) && host.inject.includes('tools'), 'host half injects tools')
  const defaults = host.Config({})
  check(defaults.statsPersist === 'aggregate', 'statsPersist defaults to aggregate')
  check(defaults.uiPill === true, 'uiPill defaults to true')
  check(defaults.rewriteSemanticGuard === 'enforce', 'semantic guard defaults to enforce')

  // The browser half registers a factory with the page module table.
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registrations.push(entry)
      },
    },
  }
  globalThis.document = {
    baseURI: 'http://localhost/',
    documentElement: { lang: 'en' },
    getElementById: () => null,
    createElement: () => ({ set textContent(value) {}, set id(value) {} }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  await import(pathToFileURL(join(root, 'lib/client.js')).href)
  check(registrations.length === 1, 'client half registers exactly one factory')
  check(registrations[0]?.id === 'dsh-rtk-workbench', 'client factory id is the package name')
  const plugin = registrations[0]?.factory((id) => (id === 'react' ? {} : undefined))
  check(plugin?.name === 'dsh-rtk-workbench', 'client plugin exports name')
  check(typeof plugin?.apply === 'function', 'client plugin exports apply')
  check(Array.isArray(plugin?.inject) && plugin.inject.includes('slots'), 'client plugin injects slots')

  // The bundled binary is present only in the GitHub "fat" tarballs: the npm
  // package ships five platform packages as optional dependencies instead (they
  // are declared at publish time, see scripts/platforms.mjs). Both shapes pass;
  // which one this is gets named in the output.
  const platform = `${process.platform}-${process.arch}`
  const binary = join(root, 'vendor', platform, process.platform === 'win32' ? 'rtk.exe' : 'rtk')
  if (existsSync(binary)) {
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
    check(/^rtk \d+\.\d+\.\d+/.test(version), `bundled binary answers --version (${version})`)
  } else {
    pass(`no vendor/ payload: npm shape, the ${platform} binary comes from its platform package`)
  }
} finally {
  delete globalThis.window
  delete globalThis.document
  rmSync(directory, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`smoke-pack: ${failures.length} failure(s)`)
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log('smoke-pack: ok')
