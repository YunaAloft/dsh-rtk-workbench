import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildPostToolUsePayload, extractHookOutput, type ResultShape } from './compress'
import { describeRun, runRtk } from './exec'

/**
 * The pipeline the plugin ships. `rtk:default` carries no `hook.after_tool`
 * rules at all — compression only happens when some pipeline file extends
 * `rtk:posthook` (measured in `memos/plans/m0-findings.md` §1).
 */
export const PIPELINE_TOML = `# dsh-rtk-workbench — plugin-owned rtk pipeline.
# Injected per invocation through RTK_CONFIG_DIR, so the user's own
# %APPDATA%\\\\rtk\\\\config.toml and filters.toml are untouched.
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
 * Only `RTK_CONFIG_DIR` is overridden, and only in the modes that ship the
 * plugin pipeline. `auto` starts from the plugin-owned environment and lets the
 * runtime probe remove the override once it has proven that the user's own
 * pipeline already compresses (see `userPipelineCompresses`).
 *
 * `RTK_DB_PATH` and `RTK_TEE_DIR` are deliberately left alone: the model runs
 * `rtk recall <hash>` through the ordinary shell, so redirecting the tee/DB
 * would make recovery impossible (verified end to end in m0-findings §2).
 *
 * @param mode - `user` leaves the environment untouched; the others inject.
 * @param baseEnv - environment to extend.
 * @returns the environment plus the directory that was selected.
 */
export function pipelineEnv(
  mode: 'plugin-owned' | 'user' | 'auto',
  baseEnv: NodeJS.ProcessEnv = process.env,
): PipelineEnv {
  if (mode === 'user') return { env: baseEnv, configDir: '' }
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

/** What `rtk pipeline show` says about the resolved pipeline. */
export interface PipelineShowInfo {
  readonly name?: string
  readonly fellBack: boolean
  readonly dropped: readonly string[]
  readonly untrusted: readonly string[]
}

/**
 * Parse `rtk pipeline show` without depending on its layout beyond the four
 * markers that matter: the resolved name, the fall-back notice, files dropped
 * for errors, and trust diagnostics.
 *
 * @param output - stdout of the command.
 */
export function parsePipelineShow(output: string): PipelineShowInfo {
  let name: string | undefined
  let fellBack = false
  const dropped: string[] = []
  const untrusted: string[] = []
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('Pipeline:')) name = line.slice('Pipeline:'.length).trim()
    else if (line.includes('fell back to the built-in default')) fellBack = true
    else if (line.startsWith('(not loaded, has errors:')) dropped.push(line)
    else if (line.includes('is untrusted') || line.includes('changed since it was trusted')) untrusted.push(line)
  }
  return { name, fellBack, dropped, untrusted }
}

/** Problem lines of `rtk pipeline status` (header and consequence line removed). */
export function parsePipelineProblems(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !line.startsWith('pipeline: problems recorded') &&
        !line.startsWith('hooks are running the built-in'),
    )
}

/** Options shared by the pipeline inspections. */
export interface PipelineInspectOptions {
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly cwd?: string
}

/** One inspection outcome: healthy, or the first few concrete problems. */
export interface PipelineHealth {
  readonly ok: boolean
  readonly detail?: string
  readonly untrusted: readonly string[]
}

/**
 * Ask rtk whether the pipeline it will actually load is the one we expect.
 *
 * `rtk pipeline validate` catches a file that cannot resolve (its failure makes
 * rtk fall back to `rtk:default`, which silently removes compression);
 * `pipeline status` reports a recorded load problem; `pipeline show` is the only
 * place that names the resolved pipeline and its trust diagnostics.
 *
 * @param binary - resolved rtk path.
 * @param options - environment (with the mode's config dir), budget, cwd.
 */
export async function inspectPipeline(
  binary: string,
  options: PipelineInspectOptions,
): Promise<PipelineHealth> {
  const run = (args: readonly string[], maxBytes: number) =>
    runRtk(binary, args, {
      env: options.env,
      timeoutMs: options.timeoutMs,
      maxBytes,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })

  const show = await run(['pipeline', 'show'], 64 * 1024)
  if (show.failure !== undefined) return { ok: false, detail: describeRun(show), untrusted: [] }
  const info = parsePipelineShow(show.stdout)
  const validate = await run(['pipeline', 'validate'], 16 * 1024)
  const status = await run(['pipeline', 'status'], 16 * 1024)

  const problems: string[] = []
  if (validate.failure !== undefined || validate.code !== 0) {
    const line = (validate.stderr || validate.stdout).trim().split('\n')[0] ?? ''
    problems.push(line === '' ? `validate ${describeRun(validate)}` : line)
  }
  if (status.failure !== undefined || status.code !== 0) {
    problems.push(...parsePipelineProblems(`${status.stdout}\n${status.stderr}`).slice(0, 2))
  }
  if (info.fellBack) problems.unshift('pipeline fell back to the built-in default')
  if (info.dropped.length > 0) problems.unshift(...info.dropped)
  if (problems.length === 0) return { ok: true, untrusted: info.untrusted }
  return { ok: false, detail: problems.slice(0, 3).join(' | '), untrusted: info.untrusted }
}

/** Two samples: a term-shaped log and a read-shaped JSON body. */
const USER_PIPELINE_SAMPLES: ReadonlyArray<{
  readonly shape: ResultShape
  readonly command: string
  readonly path: string
  readonly text: string
}> = [
  {
    shape: 'bash',
    command: 'cat sample.log',
    path: '',
    text: 'PASS test_0 ok\n'.repeat(200),
  },
  {
    shape: 'read',
    command: '',
    path: 'sample.json',
    text: JSON.stringify({ items: Array.from({ length: 400 }, (_, index) => ({ id: index, name: `n${index}` })) }),
  },
]

/**
 * Whether the user's own rtk pipeline already compresses tool output.
 *
 * Runs the same synthetic PostToolUse round trip with `RTK_CONFIG_DIR` removed,
 * so the answer describes what the user's `%APPDATA%\rtk` pipeline does on its
 * own. Two samples avoid a false negative for a pipeline that only handles JSON
 * or only logs; a false negative would make `auto` inject our pipeline and
 * shadow theirs.
 *
 * @param binary - resolved rtk path.
 * @param options - environment (may contain our override), budget, cwd.
 */
export async function userPipelineCompresses(
  binary: string,
  options: PipelineInspectOptions,
): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...options.env }
  delete env.RTK_CONFIG_DIR
  for (const sample of USER_PIPELINE_SAMPLES) {
    const payload = buildPostToolUsePayload(sample.shape, sample.command, sample.path, sample.text)
    const run = await runRtk(binary, ['hook', 'claude'], {
      input: payload,
      env,
      timeoutMs: options.timeoutMs,
      maxBytes: sample.text.length * 2 + 64 * 1024,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })
    if (run.failure !== undefined || run.code !== 0) continue
    const updated = extractHookOutput(sample.shape, run.stdout)
    if (updated !== null && updated.text.length < sample.text.length) return true
  }
  return false
}
