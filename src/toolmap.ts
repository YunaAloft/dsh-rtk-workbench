import type { Config } from './config'

/** Shell dialect a tool name implies; rtk only rewrites POSIX syntax today. */
export type Dialect = 'posix' | 'powershell' | 'unknown'

/** How a tool name was matched against the configured lists. */
export type DetectLayer = 'canonical' | 'alias' | 'explicit' | 'none'

/** Per-call verdict for one tool name. */
export interface ToolDecision {
  readonly name: string
  readonly dialect: Dialect
  readonly layer: DetectLayer
  readonly rewrite: boolean
  readonly compress: boolean
}

/**
 * Prefixes third-party plugins use when they republish an official tool under a
 * new name. `dsh-ops` is the live example: on Windows it publishes `ops_bash`
 * and restricts the official `pwsh` (README: "用它替换官方 pwsh").
 */
const ALIAS_PREFIXES = ['ops_'] as const

/**
 * Strip a known alias prefix, giving the official name the tool stands in for.
 *
 * @param name - the tool name seen at dispatch time.
 */
export function aliasBase(name: string): string {
  for (const prefix of ALIAS_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length)
  }
  return name
}

/** Dialect for one tool name (alias-aware). */
export function dialectOf(name: string): Dialect {
  const base = aliasBase(name)
  if (base === 'bash' || base === 'sh' || base === 'zsh' || base === 'shell') return 'posix'
  if (base === 'pwsh' || base === 'powershell') return 'powershell'
  return 'unknown'
}

/**
 * Whether a name matches a configured list, either literally or through its
 * official alias. `matchesList('ops_bash', ['bash'])` is true, which is what
 * makes the compatibility layer automatic without a second config surface.
 */
export function matchesList(name: string, list: readonly string[]): boolean {
  const base = aliasBase(name)
  return list.includes(name) || (base !== name && list.includes(base))
}

/**
 * Decide what the plugin may do with one tool name.
 *
 * Detection order is canonical official name → alias (through `ops_`) →
 * explicit configuration. PowerShell stays out of rewriting because rtk defers
 * every PowerShell command it has been shown (measured: m0-findings §4), so
 * enabling it would only spend a ~206 ms spawn per call for no benefit.
 *
 * @param name - tool name at dispatch time.
 * @param config - validated plugin config.
 */
export function decideTool(name: string, config: Config): ToolDecision {
  const excluded = config.excludeTools.includes(name)
  const dialect = dialectOf(name)
  const canonical = name === aliasBase(name)

  let layer: DetectLayer = 'none'
  if (matchesList(name, config.shellTools) || matchesList(name, config.rewriteTools)) {
    layer = canonical ? 'canonical' : 'alias'
  } else if (config.compressTools.includes(name) || config.compressTools.includes('*')) {
    layer = 'explicit'
  }

  // The dialect no longer blocks rewriting: it only selects the pre-filter.
  // `rewriteTools` is an explicit allowlist, and PowerShell is worth trying
  // because the interesting pwsh calls are real programs (git, cargo, docker).
  const rewrite = !excluded && config.rewriteEnabled && matchesList(name, config.rewriteTools)

  const compress =
    !excluded &&
    config.compressEnabled &&
    (config.compressTools.includes('*') || matchesList(name, config.compressTools))

  return { name, dialect, layer, rewrite, compress }
}

/** Extract the shell command a call carries, if any. */
export function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>).command
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Extract the file path a call carries, if any (read/write family). */
export function pathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}
