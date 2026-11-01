/**
 * The platforms this package ships a bundled rtk binary for.
 *
 * Shared by `build-vendor.mjs` (downloads and packs) and `release.mjs` (declares
 * the platform packages as `optionalDependencies` at publish time).
 *
 * The repository's own `package.json` deliberately carries no
 * `optionalDependencies`: the packages do not exist on the registry yet, so
 * declaring them there would make `pnpm install --frozen-lockfile` fail in CI
 * (the lockfile cannot record a resolution that does not exist).
 */
export const PLATFORMS = [
  { id: 'win32-x64', os: 'win32', cpu: 'x64', asset: 'rtk-x86_64-pc-windows-msvc.zip', bin: 'rtk.exe' },
  { id: 'darwin-x64', os: 'darwin', cpu: 'x64', asset: 'rtk-x86_64-apple-darwin.tar.gz', bin: 'rtk' },
  { id: 'darwin-arm64', os: 'darwin', cpu: 'arm64', asset: 'rtk-aarch64-apple-darwin.tar.gz', bin: 'rtk' },
  { id: 'linux-x64', os: 'linux', cpu: 'x64', asset: 'rtk-x86_64-unknown-linux-musl.tar.gz', bin: 'rtk' },
  { id: 'linux-arm64', os: 'linux', cpu: 'arm64', asset: 'rtk-aarch64-unknown-linux-gnu.tar.gz', bin: 'rtk' },
]

/**
 * npm name of the package carrying one platform's binary.
 *
 * Unscoped on purpose: a scope other than a username needs an npm organization,
 * and `@username/...` would hide the package's association with this plugin.
 * `dsh-rtk-workbench-win32-x64` spells out both, and needs no registry paperwork.
 */
export function platformPackageName(id) {
  return `dsh-rtk-workbench-${id}`
}

/**
 * The `optionalDependencies` map the published main package should declare.
 *
 * @param version - the rtk version the binaries were built from.
 */
export function platformDependencies(version) {
  return Object.fromEntries(PLATFORMS.map((platform) => [platformPackageName(platform.id), version]))
}
