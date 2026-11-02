import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'
import { describeRun, runRtk } from './rtk/exec'
import { AWARENESS_SECTION_NAME } from './awareness'
import { decideTool } from './toolmap'

/** One command outcome, matching the host's `CommandResult` union. */
export type CommandOutcome =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Structural view of the host command service; keeps this plugin dependency-free. */
export interface CommandsLike {
  register(definition: {
    readonly definitionId?: string
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint?: string }
    readonly handler: (invocation: { readonly rawInput: string; readonly agent: unknown }) => CommandOutcome | Promise<CommandOutcome>
  }): () => void
}

/** Everything `/rtk` reports on or mutates. */
export interface CommandContext {
  readonly ctx: Context
  readonly config: Config
  readonly binary: string
  readonly binarySource: string
  /** Live pipeline state: which pipeline runs, where it lives, and its health. */
  readonly pipeline: () => {
    readonly mode: 'plugin-owned' | 'user'
    readonly dir: string
    readonly health: 'unknown' | 'ok' | 'problems'
    readonly detail?: string
    readonly trust: readonly string[]
  }
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly patched: () => readonly string[]
  readonly skipped: () => ReadonlyMap<string, string>
  /** How many results a downstream listener had already transformed. */
  readonly foreignTransforms: () => number
  /** Last capability probe outcome. */
  readonly capability: () => { readonly state: 'unknown' | 'ok' | 'fail'; readonly detail: string }
}

const HELP = [
  'rtk-workbench — /rtk <subcommand>',
  '  status         binary, pipeline, switches and observations',
  '  tools          how each visible tool resolved (canonical / alias / explicit)',
  '  doctor         deep self-check: binary, pipeline, round trip, recall',
  '  gain           forward to `rtk gain`',
  '  recall <hash>  restore output rtk elided',
  '  on|off <rewrite|compress>   toggle a switch for this session',
].join('\n')

/** Render a boolean switch. */
function flag(value: boolean): string {
  return value ? 'on' : 'off'
}

/** Longest budget a diagnostic command gives one probe. */
const DIAGNOSTIC_TIMEOUT_FLOOR = 8000

/**
 * Build the `/rtk` command handler.
 *
 * Commands are the human-facing registration surface: they never enter the
 * model's context and add no tool schema, so this does not contradict the
 * "never register a new tool" rule.
 *
 * @param context - live plugin state the commands report on or mutate.
 */
export function createCommandHandler(context: CommandContext) {
  const { ctx, config, binary } = context

  /** Budget shared by the diagnostic probes. */
  const budget = Math.max(context.timeoutMs, DIAGNOSTIC_TIMEOUT_FLOOR)

  /** `version` output of the installed binary, or a reason it is unusable. */
  async function version(): Promise<string> {
    const run = await runRtk(binary, ['--version'], { timeoutMs: budget, env: context.env, maxBytes: 4096 })
    if (run.failure !== undefined) return `unavailable (${describeRun(run)})`
    if (run.code !== 0) return `unusable (${describeRun(run)})`
    return (run.stdout || run.stderr).trim()
  }

  /**
   * Whether the recall store is usable. Compression output points at
   * `rtk recall <hash>`, so a broken store silently removes the recovery path —
   * worth one line in `status`, not just in `doctor`.
   */
  async function recallState(): Promise<string> {
    const run = await runRtk(binary, ['recall', '--list'], { timeoutMs: budget, env: context.env, maxBytes: 64 * 1024 })
    if (run.failure !== undefined) return `unavailable (${describeRun(run)})`
    if (run.code !== 0) return `unavailable (${(run.stderr || '').trim().split('\n')[0] ?? 'exit ' + String(run.code)})`
    const entries = run.stdout.split('\n').filter((line) => line.trim() !== '').length - 1
    return `ok (${String(Math.max(0, entries))} stored output(s))`
  }

  async function status(): Promise<CommandOutcome> {
    const probe = context.capability()
    const pipeline = context.pipeline()
    const pipelineLine =
      pipeline.health === 'unknown'
        ? 'checking…'
        : pipeline.health === 'ok'
          ? 'ok'
          : `problems — ${pipeline.detail ?? 'see /rtk doctor'}`
    const lines = [
      `binary     : ${binary}  (${context.binarySource})`,
      `probe      : ${probe.state}${probe.detail === '' ? '' : ` — ${probe.detail}`}`,
      `version    : ${await version()}`,
      `recall     : ${await recallState()}`,
      `pipeline   : ${pipeline.mode}${pipeline.dir === '' ? '' : ` (${pipeline.dir})`}  ${pipelineLine}`,
      `rewrite    : ${flag(config.rewriteEnabled)}   tools: ${config.rewriteTools.join(', ')}`,
      `compress   : ${flag(config.compressEnabled)}   threshold: ${String(config.compressThresholdBytes)} B`,
      `awareness  : ${flag(config.awarenessEnabled)}   section: ${AWARENESS_SECTION_NAME}`,
      `deny       : ${flag(config.denyEnabled)}`,
      `patched    : ${context.patched().join(', ') || '(none yet)'}`,
    ]
    for (const line of pipeline.trust.slice(0, 2)) lines.push(`  trust      : ${line}`)
    const skipped = [...context.skipped().entries()]
    if (skipped.length > 0) {
      lines.push('skipped    :')
      for (const [name, reason] of skipped) lines.push(`  ${name}: ${reason}`)
    }
    const foreign = context.foreignTransforms()
    if (foreign > 0) lines.push(`observed   : another result transformer changed ${String(foreign)} result(s) this session`)
    return { kind: 'success', text: lines.join('\n') }
  }

  async function tools(agent: unknown): Promise<CommandOutcome> {
    let names: string[] = []
    try {
      names = ctx.tools.schemas(agent as never).map((schema) => schema.name)
    } catch {
      names = []
    }
    if (names.length === 0) names = [...new Set([...config.shellTools, ...config.rewriteTools])]
    const wildcard = config.compressTools.includes('*')
    const rows = names
      .map((name) => ({ name, decision: decideTool(name, config) }))
      // Shell tools always show; other tools only when they were named
      // explicitly, because the `*` wildcard would otherwise print every tool in
      // the session and bury the three lines that matter.
      .filter((row) => row.decision.rewrite || (row.decision.compress && !wildcard))
      .sort((a, b) => a.name.localeCompare(b.name))
    const lines: string[] = []
    for (const { name, decision } of rows) {
      const marks = [decision.layer, decision.rewrite ? 'rewrite' : '', decision.compress ? 'compress' : ''].filter(
        (mark) => mark !== '',
      )
      lines.push(`${name.padEnd(18)} ${decision.dialect.padEnd(11)} ${marks.join(' + ')}`)
    }
    if (wildcard) {
      const covered = names.filter((name) => decideTool(name, config).compress)
      const sample = covered.slice(0, 6).join(', ')
      lines.push('')
      lines.push(
        `compress: every tool's text result (${String(covered.length)} visible here: ${sample}${covered.length > 6 ? ', …' : ''})`,
      )
    }
    lines.push(
      `patched: ${context.patched().join(', ') || '(none yet — the first call to a shell tool installs the wrapper)'}`,
    )
    return { kind: 'success', text: lines.join('\n') }
  }

  /** Deep self-check: everything a user needs to paste into a bug report. */
  async function doctor(): Promise<CommandOutcome> {
    const lines = ['rtk-workbench doctor', `platform   : ${process.platform} ${process.arch}`, `binary     : ${binary}  (${context.binarySource})`]
    const versionRun = await runRtk(binary, ['--version'], { timeoutMs: budget, env: context.env, maxBytes: 4096 })
    lines.push(`rtk        : ${(versionRun.stdout || versionRun.stderr).trim() || describeRun(versionRun)}`)

    const pipelineRun = await runRtk(binary, ['pipeline', 'show', 'rtk:posthook'], {
      timeoutMs: budget,
      env: context.env,
      maxBytes: 64 * 1024,
    })
    lines.push(
      `pipeline   : ${pipelineRun.failure === undefined && pipelineRun.code === 0 ? 'rtk:posthook available' : describeRun(pipelineRun)}`,
    )

    // The three commands rtk ships for diagnosing the *injected* pipeline: a
    // file that fails to resolve silently falls back to `rtk:default`, which
    // removes compression without changing a single switch in this plugin.
    const firstLine = (text: string): string => text.trim().split('\n')[0]?.slice(0, 160) ?? ''
    const showRun = await runRtk(binary, ['pipeline', 'show'], { timeoutMs: budget, env: context.env, maxBytes: 64 * 1024 })
    lines.push(
      `show       : ${showRun.failure === undefined && showRun.code === 0 ? firstLine(showRun.stdout) : describeRun(showRun)}`,
    )
    const validateRun = await runRtk(binary, ['pipeline', 'validate'], {
      timeoutMs: budget,
      env: context.env,
      maxBytes: 16 * 1024,
    })
    lines.push(
      `validate   : ${validateRun.failure === undefined && validateRun.code === 0 ? 'ok' : firstLine(validateRun.stderr || validateRun.stdout) || describeRun(validateRun)}`,
    )
    const statusRun = await runRtk(binary, ['pipeline', 'status'], {
      timeoutMs: budget,
      env: context.env,
      maxBytes: 16 * 1024,
    })
    lines.push(
      `pl status  : ${statusRun.failure === undefined && statusRun.code === 0 ? 'ok' : firstLine(statusRun.stdout || statusRun.stderr)}`,
    )
    const methodsRun = await runRtk(binary, ['methods', 'list'], { timeoutMs: budget, env: context.env, maxBytes: 16 * 1024 })
    lines.push(
      `methods    : ${methodsRun.failure === undefined && methodsRun.code === 0 ? `${String(methodsRun.stdout.split('\n').length - 1)} listed` : describeRun(methodsRun)}`,
    )
    const trustRun = await runRtk(binary, ['trust', '--list'], { timeoutMs: budget, env: context.env, maxBytes: 16 * 1024 })
    lines.push(
      `trust      : ${trustRun.failure === undefined && trustRun.code === 0 ? firstLine(trustRun.stdout) || 'none' : describeRun(trustRun)}`,
    )

    const sample = 'PASS test_0 ok\n'.repeat(200)
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cat sample.log' },
      tool_response: { stdout: sample, stderr: '', interrupted: false },
    })
    const roundTrip = await runRtk(binary, ['hook', 'claude'], {
      input: payload,
      timeoutMs: budget,
      env: context.env,
      maxBytes: 256 * 1024,
    })
    let roundTripNote = describeRun(roundTrip)
    if (roundTrip.failure === undefined && roundTrip.code === 0) {
      roundTripNote =
        roundTrip.stdout.trim() === '' ? 'no change (no rule fired)' : `answered (${String(roundTrip.stdout.length)} B)`
    }
    lines.push(`round trip : ${roundTripNote}`)

    const recallRun = await runRtk(binary, ['recall', '--list'], {
      timeoutMs: budget,
      env: context.env,
      maxBytes: 32 * 1024,
    })
    if (recallRun.failure === undefined && recallRun.code === 0) {
      lines.push('recall     : store reachable')
    } else {
      // A broken store is not fatal — rtk then omits its `[full output: rtk recall …]`
      // hint, so compression still works and nothing points at a dead command.
      const reason = describeRun(recallRun)
      const note = /store unavailable|init recall schema/i.test(reason)
        ? ' (compressed output omits the recall hint; usually a read-only or ACL-restricted install dir)'
        : ''
      lines.push(`recall     : ${reason}${note}`)
    }
    lines.push(`profile    : ${context.pipeline().mode}${context.pipeline().dir === '' ? '' : ` (${context.pipeline().dir})`}`)
    lines.push(`patched    : ${context.patched().join(', ') || '(none yet)'}`)
    return { kind: 'success', text: lines.join('\n') }
  }

  async function forward(args: readonly string[], label: string): Promise<CommandOutcome> {
    const run = await runRtk(binary, [...args], { timeoutMs: Math.max(context.timeoutMs, 5000), env: context.env })
    if (run.failure !== undefined) return { kind: 'error', text: `${label}: rtk did not run (${describeRun(run)})` }
    const text = (run.stdout + run.stderr).trim()
    if (run.code !== 0 && text === '') return { kind: 'error', text: `${label}: exit ${String(run.code)}` }
    return { kind: 'success', text: text === '' ? `${label}: (no output)` : text }
  }

  /**
   * Dispatch one `/rtk` invocation.
   *
   * @param invocation - raw text after the command name and the calling agent.
   */
  async function handle(invocation: { readonly rawInput: string; readonly agent: unknown }): Promise<CommandOutcome> {
    const raw = invocation.rawInput.trim()
    const [sub = 'status', ...rest] = raw.split(/\s+/).filter((part) => part !== '')
    switch (sub) {
      case 'status':
        return await status()
      case 'tools':
        return await tools(invocation.agent)
      case 'doctor':
        return await doctor()
      case 'gain':
        return await forward(['gain'], 'rtk gain')
      case 'recall':
        if (rest.length === 0) return { kind: 'error', text: 'usage: /rtk recall <hash>' }
        return await forward(['recall', rest[0] ?? ''], 'rtk recall')
      case 'on':
      case 'off': {
        const target = rest[0]
        const enabled = sub === 'on'
        if (target !== 'rewrite' && target !== 'compress') {
          return { kind: 'error', text: 'usage: /rtk on|off rewrite|compress' }
        }
        if (target === 'rewrite') config.rewriteEnabled = enabled
        else config.compressEnabled = enabled
        return { kind: 'success', text: `${target} ${flag(enabled)}` }
      }
      default:
        return { kind: 'success', text: HELP }
    }
  }

  return { handle }
}
