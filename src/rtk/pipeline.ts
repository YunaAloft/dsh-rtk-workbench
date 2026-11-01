import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The pipeline the plugin ships. `rtk:default` carries no `hook.after_tool`
 * rules at all — compression only happens when some pipeline file extends
 * `rtk:posthook` (measured in `memos/plans/m0-findings.md` §1).
 */
export const PIPELINE_TOML = `# dsh-rtk-workbench — plugin-owned rtk pipeline.
# Injected per invocation through RTK_CONFIG_DIR, so the user's own
# %APPDATA%\\rtk\\config.toml and filters.toml are untouched.
schema_version = 1

[pipeline]
name    = "dsh-rtk-workbench"
extends = "rtk:posthook"
`

/** Where the plugin keeps its own state (pipeline file, nothing else). */
export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = (env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'rtk-workbench')
}

export interface PipelineEnv {
  readonly env: NodeJS.ProcessEnv
  /** Directory handed to rtk as `RTK_CONFIG_DIR`; empty in `user` mode. */
  readonly configDir: string
}

/**
 * Prepare the environment for one rtk invocation.
 *
 * Only `RTK_CONFIG_DIR` is overridden, and only in `plugin-owned` mode.
 * `RTK_DB_PATH` and `RTK_TEE_DIR` are deliberately left alone: the model runs
 * `rtk recall <hash>` through the ordinary shell, so redirecting the tee/DB
 * would make recovery impossible (verified end to end in m0-findings §2).
 *
 * The file is always prepared in `plugin-owned` mode, even when compression is
 * loaded disabled: `/rtk on compress` can enable it at runtime, and an
 * environment captured without `RTK_CONFIG_DIR` would then leave rtk with no
 * `after_tool` rules — compression would silently do nothing.
 *
 * @param mode - `plugin-owned` writes and injects the pipeline; `user` does not.
 * @param baseEnv - environment to extend.
 * @returns the environment plus the directory that was selected.
 */
export function pipelineEnv(
  mode: 'plugin-owned' | 'user',
  baseEnv: NodeJS.ProcessEnv = process.env,
): PipelineEnv {
  if (mode !== 'plugin-owned') return { env: baseEnv, configDir: '' }
  const dir = join(pluginDataDir(baseEnv), 'pipeline')
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'pipeline.toml')
    let current = ''
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      current = ''
    }
    if (current !== PIPELINE_TOML) writeFileSync(file, PIPELINE_TOML, 'utf8')
  } catch {
    // A read-only DSH_HOME must not break tool execution: without the pipeline
    // rtk simply reports "nothing to compress" and every call stays identity.
    return { env: baseEnv, configDir: '' }
  }
  return { env: { ...baseEnv, RTK_CONFIG_DIR: dir }, configDir: dir }
}
