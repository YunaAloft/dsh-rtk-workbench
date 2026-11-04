import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Platforms we publish a bundled binary for. */
const SUPPORTED = new Set(['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'])

/**
 * Whether this build carries a binary for a platform, and the package id it
 * would come from.
 *
 * `/rtk doctor` reports this so "installed but rtk unusable" has one obvious
 * cause: a platform rtk itself does not publish a build for.
 *
 * @param platform - defaults to the running platform.
 * @param arch - defaults to the running architecture.
 */
export function platformSupport(
  platform: string = process.platform,
  arch: string = process.arch,
): { readonly id: string; readonly supported: boolean } {
  const id = `${platform}-${arch}`
  return { id, supported: SUPPORTED.has(id) }
}

/** Executable name inside a bundled payload. */
function binaryName(platform: string): string {
  return platform === 'win32' ? 'rtk.exe' : 'rtk'
}

/**
 * Make a bundled binary executable.
 *
 * A tarball packed on Windows records mode 0644 for every file (there is no
 * executable bit there), so the same artifact installed on macOS or Linux would
 * fail to spawn with `EACCES`. Repairing the mode at resolution time keeps one
 * build usable everywhere.
 */
function ensureExecutable(path: string, platform: string): string {
  if (platform !== 'win32') {
    try {
      chmodSync(path, 0o755)
    } catch {
      /* read-only installation: spawn will report the real error */
    }
  }
  return path
}

/**
 * Locate a binary shipped with this package, if any.
 *
 * Two layouts are checked, in order:
 *
 * 1. **Optional platform package** — `dsh-rtk-workbench-<os>-<arch>`, the
 *    npm-distributed shape. `optionalDependencies` means a missing or failed
 *    download simply never resolves here. The scoped name below is the legacy
 *    spelling and is still accepted, so an install that pinned an older release
 *    keeps resolving.
 * 2. **Fat tarball** — `<package>/vendor/<os>-<arch>/rtk[.exe]`, the
 *    GitHub-Release shape where one tarball carries its own platform.
 *
 * @param platform - defaults to the running platform; injectable for tests.
 * @param arch - defaults to the running architecture; injectable for tests.
 * @returns the resolved path, or `undefined` when this build carries no binary.
 */
export function bundledRtkPath(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const id = `${platform}-${arch}`
  if (!SUPPORTED.has(id)) return undefined
  const name = binaryName(platform)

  try {
    const require = createRequire(import.meta.url)
    for (const specifier of [`dsh-rtk-workbench-${id}/package.json`, `@dsh-rtk-workbench/rtk-${id}/package.json`]) {
      try {
        const manifest = require.resolve(specifier)
        const candidate = join(dirname(manifest), 'bin', name)
        if (existsSync(candidate)) return ensureExecutable(candidate, platform)
      } catch {
        /* try the next spelling */
      }
    }
  } catch {
    /* not installed for this platform */
  }

  try {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const candidate = join(packageRoot, 'vendor', id, name)
    if (existsSync(candidate)) return ensureExecutable(candidate, platform)
  } catch {
    /* bundlers may not provide a file URL here */
  }

  return undefined
}
