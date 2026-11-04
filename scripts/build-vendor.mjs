#!/usr/bin/env node
/**
 * Build the bundled-rtk artifacts.
 *
 * Produces, from a pinned rtk release:
 *   vendor/<platform>/<bin>                 extracted binaries (git-ignored)
 *   packages/rtk-<platform>/                one npm package per platform
 *   dist/npm/dsh-rtk-workbench-<platform>-<version>.tgz   those packages, packed
 *   dist/github/dsh-rtk-workbench-<v>-<platform>.tgz
 *                                           fat tarballs for GitHub Releases
 *
 * Downloads are cached in `cache/` and verified against the release's
 * `checksums.txt`, so re-runs are offline and tampering is detected.
 *
 * Usage: node scripts/build-vendor.mjs [--only <platform>] [--skip-download]
 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const RTK_VERSION = PLUGIN_MANIFEST.dshRtkVersion ?? '1.1.0'
// Platform packages carry the plugin version, matching esbuild/rollup/swc: one
// version to reason about, and a packaging fix can always be republished.
const PLUGIN_VERSION = PLUGIN_MANIFEST.version
const RELEASE = `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}`
const CACHE = join(ROOT, 'cache')
const VENDOR = join(ROOT, 'vendor')
const PACKAGES = join(ROOT, 'packages')
const DIST_NPM = join(ROOT, 'dist', 'npm')
const DIST_GH = join(ROOT, 'dist', 'github')

import { PLATFORMS, platformPackageName } from './platforms.mjs'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
const skipDownload = args.includes('--skip-download')
const targets = only === undefined ? PLATFORMS : PLATFORMS.filter((p) => p.id === only)
if (targets.length === 0) {
  console.error(`unknown platform "${String(only)}"; expected one of ${PLATFORMS.map((p) => p.id).join(', ')}`)
  process.exit(2)
}

/** Run a command and fail loudly. */
function run(command, commandArgs, options = {}) {
  // On Windows `npm` is a .cmd shim, which only the shell can execute.
  const needsShell = process.platform === 'win32' && command === 'npm'
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: needsShell, ...options })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited ${String(result.status)}`)
}

/** Download one URL into the cache, returning the local path. */
async function fetchAsset(name) {
  const target = join(CACHE, name)
  if (existsSync(target) && statSync(target).size > 0) return target
  mkdirSync(CACHE, { recursive: true })
  const response = await fetch(`${RELEASE}/${name}`, { redirect: 'follow' })
  if (!response.ok) throw new Error(`download ${name} failed: ${String(response.status)}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(target, bytes)
  console.log(`  downloaded ${name} (${(bytes.length / 1048576).toFixed(1)} MB)`)
  return target
}

/** Verify every cached asset against the release checksums. */
async function verifyChecksums() {
  const file = await fetchAsset('checksums.txt')
  const text = readFileSync(file, 'utf8')
  let checked = 0
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match === null) continue
    const [, expected, name] = match
    const local = join(CACHE, basename(name))
    if (!existsSync(local)) continue
    const actual = createHash('sha256').update(readFileSync(local)).digest('hex')
    if (actual !== expected) throw new Error(`checksum mismatch for ${name}: ${actual} != ${expected}`)
    checked += 1
  }
  console.log(`  checksums verified (${String(checked)} file(s))`)
}

/**
 * The tar to use. On Windows the first `tar` on PATH is often GNU tar from
 * Git-for-Windows, which reads `D:\...` as a remote `host:path`; the System32
 * bsdtar handles both zip and tar.gz and understands drive letters.
 */
function tarBinary() {
  if (process.platform === 'win32') {
    const system = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe')
    if (existsSync(system)) return system
  }
  return 'tar'
}

/** Extract an archive (zip or tar.gz) into a directory. */
function extract(archive, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  // Windows ships bsdtar, which reads zip; the Linux runners ship GNU tar,
  // which does not, so the Windows asset is unpacked with `unzip` there.
  if (archive.endsWith('.zip') && process.platform !== 'win32') {
    run('unzip', ['-q', '-o', archive, '-d', destination])
    return
  }
  run(tarBinary(), ['-xf', archive, '-C', destination])
}

/**
 * Copy the licence files that ship inside a release archive into the repo's
 * `licenses/` directory, so the platform packages can carry them.
 *
 * The full rtk build is Apache-2.0 for the CLI plus BUSL-1.1 for `rtk-engine`,
 * and BUSL requires its text to travel with the distributed binary. The Apache
 * one is regenerated from the archive rather than hand-copied, so it always
 * matches the version actually bundled.
 */
function captureLicenses(extractDir) {
  const target = join(ROOT, 'licenses')
  mkdirSync(target, { recursive: true })
  for (const name of ['LICENSE', 'LICENSE-ENGINE']) {
    const source = findFile(extractDir, name)
    if (source === undefined) {
      console.warn(`  warning: ${name} is missing from the archive; the bundled binary needs it`)
      continue
    }
    // The Windows zip ships CRLF and the tarballs ship LF; normalise so the
    // checked-in copy does not depend on which archive was unpacked last.
    const text = readFileSync(source, 'utf8')
    const normalised = text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
    writeFileSync(join(target, `rtk-${name}`), normalised)
  }
}

/** Find a file by basename under a directory tree. */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(full, name)
      if (nested !== undefined) return nested
    } else if (entry.name === name) {
      return full
    }
  }
  return undefined
}

/** Write one platform sub-package and return its directory. */
function writeSubPackage(platform, binary) {
  const dir = join(PACKAGES, `rtk-${platform.id}`)
  const binDir = join(dir, 'bin')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })
  const binPath = join(binDir, platform.bin)
  copyFileSync(binary, binPath)
  chmodSync(binPath, 0o755)
  const manifest = {
    name: platformPackageName(platform.id),
    version: PLUGIN_VERSION,
    description: `Bundled rtk ${RTK_VERSION} binary for ${platform.os}-${platform.cpu} (upstream: github.com/rtk-ai/rtk).`,
    // The CLI is Apache-2.0; the compression engine it links is BUSL-1.1.
    license: 'Apache-2.0 AND BUSL-1.1',
    os: [platform.os],
    cpu: [platform.cpu],
    files: ['bin', 'LICENSE', 'LICENSE-ENGINE'],
    // npm renders `repository` as "where this package's source lives", so it
    // has to point at the repo that publishes these packages. Pointing it at
    // rtk-ai/rtk would send users' issues to a project that neither publishes
    // this wrapper nor knows about it; upstream attribution lives in the
    // description and in licenses/ instead.
    repository: { type: 'git', url: 'git+https://github.com/YunaAloft/dsh-rtk-workbench.git' },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const file of ['LICENSE', 'LICENSE-ENGINE']) {
    const source = join(ROOT, 'licenses', `rtk-${file}`)
    if (existsSync(source)) copyFileSync(source, join(dir, file))
  }
  return dir
}

/** Pack a directory into a .tgz and return the tarball path. */
function packDirectory(dir, outDir) {
  mkdirSync(outDir, { recursive: true })
  const before = new Set(readdirSync(dir))
  run('npm', ['pack', '--silent'], { cwd: dir })
  const produced = readdirSync(dir).find((name) => name.endsWith('.tgz') && !before.has(name))
  if (produced === undefined) throw new Error(`npm pack produced nothing in ${dir}`)
  const from = join(dir, produced)
  const to = join(outDir, produced)
  copyFileSync(from, to)
  rmSync(from, { force: true })
  return to
}

/**
 * Stage the fat tarball for one platform: the published main package's files
 * plus that platform's binary.
 */
function packFatTarball(platform, vendorBinary) {
  const stage = join(DIST_GH, `stage-${platform.id}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const entry of ['lib', 'locale', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README-zh.md', 'LICENSE', 'licenses']) {
    const source = join(ROOT, entry)
    if (!existsSync(source)) continue
    if (statSync(source).isDirectory()) {
      // Node's own recursive copy: shelling out to `cp` breaks under cmd.exe,
      // and on POSIX it would be a fork per file anyway.
      cpSync(source, join(stage, basename(entry)), { recursive: true })
    } else {
      copyFileSync(source, join(stage, basename(entry)))
    }
  }
  const binDir = join(stage, 'vendor', platform.id)
  mkdirSync(binDir, { recursive: true })
  copyFileSync(vendorBinary, join(binDir, platform.bin))
  chmodSync(join(binDir, platform.bin), 0o755)
  // `lib/` is already built: a prepare script here would try to run tsdown in a
  // staging directory that has no node_modules.
  manifest.license = 'Apache-2.0 AND BUSL-1.1'
  manifest.scripts = {}
  manifest.devDependencies = {}
  manifest.optionalDependencies = {}
  manifest.files = [...new Set([...(manifest.files ?? []), 'vendor', 'licenses'])]
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const packed = packDirectory(stage, DIST_GH)
  rmSync(stage, { recursive: true, force: true })
  // Version-free file name: `releases/latest/download/<asset>` only stays valid
  // across releases when the asset name does not carry the version. The version
  // lives inside the package.json shipped in the tarball.
  const tarball = join(DIST_GH, `dsh-rtk-workbench-${platform.id}.tgz`)
  rmSync(tarball, { force: true })
  renameSync(packed, tarball)
  return tarball
}

mkdirSync(VENDOR, { recursive: true })
// A full build owns both output directories: leftovers from an older version
// (a previous 0.1.0 sub-package, say) would otherwise sit next to the new ones
// and invite publishing the wrong file. `--only` runs leave them alone, because
// they are deliberately partial.
if (only === undefined) {
  rmSync(DIST_NPM, { recursive: true, force: true })
  rmSync(DIST_GH, { recursive: true, force: true })
}
mkdirSync(DIST_NPM, { recursive: true })
mkdirSync(DIST_GH, { recursive: true })

console.log(`rtk ${RTK_VERSION} → ${targets.length} platform(s)`)
if (!skipDownload) {
  for (const platform of targets) await fetchAsset(platform.asset)
  await verifyChecksums()
}

const built = []
for (const platform of targets) {
  const archive = join(CACHE, platform.asset)
  if (!existsSync(archive)) throw new Error(`missing asset ${platform.asset} (run without --skip-download)`)
  const extractDir = join(VENDOR, `.extract-${platform.id}`)
  extract(archive, extractDir)
  const binary = findFile(extractDir, platform.bin)
  if (binary === undefined) throw new Error(`${platform.asset} does not contain ${platform.bin}`)
  captureLicenses(extractDir)
  const vendorDir = join(VENDOR, platform.id)
  mkdirSync(vendorDir, { recursive: true })
  const vendorBinary = join(vendorDir, platform.bin)
  copyFileSync(binary, vendorBinary)
  chmodSync(vendorBinary, 0o755)
  rmSync(extractDir, { recursive: true, force: true })

  const subPackage = writeSubPackage(platform, vendorBinary)
  const npmTarball = packDirectory(subPackage, DIST_NPM)
  const ghTarball = packFatTarball(platform, vendorBinary)
  built.push({ platform: platform.id, size: statSync(vendorBinary).size, npm: basename(npmTarball), github: basename(ghTarball) })
  console.log(`  ${platform.id}: vendor ${(statSync(vendorBinary).size / 1048576).toFixed(1)} MB`)
}

writeFileSync(
  join(DIST_GH, 'checksums.txt'),
  built.map((entry) => `${createHash('sha256').update(readFileSync(join(DIST_GH, entry.github))).digest('hex')}  ${entry.github}`).join('\n') + '\n',
)
writeFileSync(join(DIST_GH, 'manifest.json'), `${JSON.stringify({ rtkVersion: RTK_VERSION, built }, null, 2)}\n`)
console.log('done')
