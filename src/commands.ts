import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'
import { describeRun, runRtk } from './rtk/exec'
import { platformSupport } from './rtk/bundled'
import { isWorthRewriting, verbOf } from './rtk/rewrite'
import { verifyRewrite } from './rtk/verify'
import { AWARENESS_SECTION_NAME } from './awareness'
import { decideTool, dialectOf } from './toolmap'
import type { RewriteCounters } from './stats'
import type { LifetimeTotals } from './stats-file'

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
  /** Injectable rtk runner (tests); defaults to the real spawn. */
  readonly run?: typeof runRtk
  readonly patched: () => readonly string[]
  readonly skipped: () => ReadonlyMap<string, string>
  /** Session counters: status summary, full report and JSON form. */
  readonly stats: (agent: unknown) => {
    readonly lines: readonly string[]
    readonly report: string
    readonly json: string
    readonly summary: { readonly calls: number; readonly savedBytes: number }
  }
  /** Rewrite counters that live in the rewrite layer. */
  readonly rewrites: () => RewriteCounters
  /** Cross-restart totals; `undefined` when `statsPersist` is off. */
  readonly lifetime: () => LifetimeTotals | undefined
  /** How many results a downstream listener had already transformed. */
  readonly foreignTransforms: () => number
  /** Last capability probe outcome. */
  readonly capability: () => { readonly state: 'unknown' | 'ok' | 'fail'; readonly detail: string }
  /**
   * Web status/doctor route exposure, when the host runs a web carrier:
   * `undefined` until/unless the route is mounted (headless profiles never
   * mount it), then whether requests pass the host's client-connection fence
   * or are fail-closed (401) because that service was missing.
   */
  readonly webRoute?: () => { readonly mounted: boolean; readonly auth: 'authenticated' | 'fail-closed' }
}

export const HELP = [
  'rtk-workbench — /rtk <subcommand>',
  '  status         binary, pipeline, switches, session savings',
  '  stats [--json] full session report',
  '  tools          how each visible tool resolved (canonical / alias / explicit)',
  '  explain <cmd>  why a command would (not) be rewritten, via rtk hook check',
  '  doctor         deep self-check: binary, pipeline, round trip, recall, trust',
  '  gain           forward to `rtk gain` (rtk-wide totals, not this session)',
  '  recall <hash>  restore output rtk elided',
  '  on|off <rewrite|compress|ui>   toggle a switch for this session',
  '  help [topic]   this list, or one topic: pipeline, sandbox, recovery, config',
].join('\n')

/**
 * Short topic texts for `/rtk help <topic>`.
 *
 * The long-form manual lives in `docs/reference.md`; this map is the same
 * information in the place a terminal user can actually reach, and the test
 * suite checks the two stay in sync.
 */
export const HELP_TOPICS: Readonly<Record<string, string>> = {
  pipeline: [
    'pipeline — which rtk pipeline is active',
    '  auto (default): keep the plugin-owned pipeline unless the user pipeline already compresses.',
    '  plugin-owned: inject <DSH_HOME>/rtk-workbench/pipeline/pipeline.toml via RTK_CONFIG_DIR.',
    '  user: never inject; your own pipeline must extend rtk:posthook for compression.',
    '  A pipeline that fails to load silently falls back to rtk:default (no after_tool rules),',
    '  which removes compression while every switch still reads on. /rtk status shows it and',
    '  /rtk doctor runs pipeline show / validate / status.',
  ].join('\n'),
  sandbox: [
    'sandbox — what a confined session changes',
    '  Windows + workspace-write/read-only: the host denies rtk the right to spawn the real',
    '  command, so rewrites are skipped (compression still works). rewriteSandboxGuard: off forces.',
    '  Any sandbox: the model shell can read files but cannot write rtk recall store, so the',
    '  plugin spills the original text when it compresses (spillOriginal: auto).',
  ].join('\n'),
  recovery: [
    'recovery — getting the original back',
    '  1. rtk recall <hash> from a result that shows the hint (the user can run /rtk recall <hash>).',
    '  2. A [rtk] original saved: <path> line means the text was spilled; read that path.',
    '  3. If recall fails with a store error, the shell is sandboxed away from the database.',
  ].join('\n'),
  config: [
    'config — where knobs live',
    "  Every key is in cordis.patch.yml; defaults are in the plugin's Schema.",
    '  Most useful: rewriteEnabled, compressEnabled, pipelineMode, rewriteSandboxGuard,',
    '  rewriteSemanticGuard, compressThresholdBytes / compressThresholdByFamily, spillOriginal,',
    '  annotateStyle, statsPersist (cross-restart counters), uiPill (the web GUI pill).',
    '  The full table is in docs/reference.md.',
  ].join('\n'),
}


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
  const run = context.run ?? runRtk

  /** Budget shared by the diagnostic probes. */
  const budget = Math.max(context.timeoutMs, DIAGNOSTIC_TIMEOUT_FLOOR)

  /** `version` output of the installed binary, or a reason it is unusable. */
  async function version(): Promise<string> {
    const result = await run(binary, ['--version'], { timeoutMs: budget, env: context.env, maxBytes: 4096 })
    if (result.failure !== undefined) return `unavailable (${describeRun(result)})`
    if (result.code !== 0) return `unusable (${describeRun(result)})`
    return (result.stdout || result.stderr).trim()
  }

  /**
   * Whether the recall store is usable. Compression output points at
   * `rtk recall <hash>`, so a broken store silently removes the recovery path —
   * worth one line in `status`, not just in `doctor`.
   */
  async function recallState(): Promise<string> {
    const result = await run(binary, ['recall', '--list'], { timeoutMs: budget, env: context.env, maxBytes: 64 * 1024 })
    if (result.failure !== undefined) return `unavailable (${describeRun(result)})`
    if (result.code !== 0) return `unavailable (${(result.stderr || '').trim().split('\n')[0] ?? 'exit ' + String(result.code)})`
    const entries = result.stdout.split('\n').filter((line) => line.trim() !== '').length - 1
    return `ok (${String(Math.max(0, entries))} stored output(s))`
  }

  async function status(agent: unknown): Promise<CommandOutcome> {
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
      `guard      : ${config.rewriteSemanticGuard}   (rejects rewrites that drop arguments)`,
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
    const stats = context.stats(agent)
    lines.push(...stats.lines)
    // A pipeline that fell back to `rtk:default` removes compression entirely
    // while every switch still reads "on". Two independent signals must agree:
    // the probe recorded a problem, and this session's attempts saved nothing.
    if (
      config.compressEnabled &&
      pipeline.health === 'problems' &&
      stats.summary.calls >= 5 &&
      stats.summary.savedBytes <= 0
    ) {
      lines.push(
        `compress   : 0 bytes saved in ${String(stats.summary.calls)} calls — the injected pipeline is not active (see /rtk doctor)`,
      )
    }
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
    const platform = platformSupport()
    const lines = ['rtk-workbench doctor', `platform   : ${process.platform} ${process.arch}`, `binary     : ${binary}  (${context.binarySource})`]
    lines.push(
      platform.supported
        ? `platform pkg: dsh-rtk-workbench-${platform.id}  (bundled binary expected)`
        : `platform pkg: none for ${platform.id} — this rtk release publishes no build for it; set rtkPath to an rtk on PATH (or inside WSL) or use a different plugin`,
    )
    const versionRun = await run(binary, ['--version'], { timeoutMs: budget, env: context.env, maxBytes: 4096 })
    lines.push(`rtk        : ${(versionRun.stdout || versionRun.stderr).trim() || describeRun(versionRun)}`)
    const webRoute = context.webRoute?.()
    lines.push(
      webRoute === undefined || !webRoute.mounted
        ? 'web route  : not mounted (headless profile)'
        : webRoute.auth === 'authenticated'
          ? 'web route  : /api/rtk-workbench (authenticated via client-connection)'
          : 'web route  : /api/rtk-workbench (FAIL-CLOSED: client-connection unavailable, answering 401)',
    )

    const pipelineRun = await run(binary, ['pipeline', 'show', 'rtk:posthook'], {
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
    const showRun = await run(binary, ['pipeline', 'show'], { timeoutMs: budget, env: context.env, maxBytes: 64 * 1024 })
    lines.push(
      `show       : ${showRun.failure === undefined && showRun.code === 0 ? firstLine(showRun.stdout) : describeRun(showRun)}`,
    )
    const validateRun = await run(binary, ['pipeline', 'validate'], {
      timeoutMs: budget,
      env: context.env,
      maxBytes: 16 * 1024,
    })
    lines.push(
      `validate   : ${validateRun.failure === undefined && validateRun.code === 0 ? 'ok' : firstLine(validateRun.stderr || validateRun.stdout) || describeRun(validateRun)}`,
    )
    const statusRun = await run(binary, ['pipeline', 'status'], {
      timeoutMs: budget,
      env: context.env,
      maxBytes: 16 * 1024,
    })
    lines.push(
      `pl status  : ${statusRun.failure === undefined && statusRun.code === 0 ? 'ok' : firstLine(statusRun.stdout || statusRun.stderr)}`,
    )
    const methodsRun = await run(binary, ['methods', 'list'], { timeoutMs: budget, env: context.env, maxBytes: 16 * 1024 })
    lines.push(
      `methods    : ${methodsRun.failure === undefined && methodsRun.code === 0 ? `${String(methodsRun.stdout.split('\n').length - 1)} listed` : describeRun(methodsRun)}`,
    )
    const trustRun = await run(binary, ['trust', '--list'], { timeoutMs: budget, env: context.env, maxBytes: 16 * 1024 })
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
    const roundTrip = await run(binary, ['hook', 'claude'], {
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

    const recallRun = await run(binary, ['recall', '--list'], {
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

  /**
   * Explain one command end to end: the local pre-filter, then rtk's own hook
   * decision (`rtk hook check` runs the same decision a hook would).
   *
   * @param parts - the command words after `explain`.
   */
  async function explain(parts: readonly string[]): Promise<CommandOutcome> {
    const command = parts.join(' ').trim()
    if (command === '') return { kind: 'error', text: 'usage: /rtk explain <command>' }
    const counters = context.rewrites()
    const verb = verbOf(command) ?? ''
    const excluded = verb !== '' && config.rewriteExcludeCommands.includes(verb)
    const local = [
      `command    : ${command}`,
      `verb       : ${verb === '' ? '(none)' : verb}`,
      `excluded   : ${excluded ? 'yes (rewriteExcludeCommands)' : 'no'}`,
      `learned    : ${counters.learned.includes(verb) ? 'yes (rtk failed earlier this session)' : 'no'}`,
      `pre-filter : ${isWorthRewriting(command, dialectOf(config.rewriteTools[0] ?? 'bash'), new Set(config.rewriteExcludeCommands)) ? 'eligible' : 'deferred locally'}`,
    ]
    const check = await run(binary, ['hook', 'check', '--agent', 'claude', command], {
      timeoutMs: Math.max(context.timeoutMs, 5000),
      env: context.env,
      maxBytes: 64 * 1024,
    })
    let note: string
    if (check.failure !== undefined) note = describeRun(check)
    else if (check.code === 0) {
      const proposal = check.stdout.trim()
      const guard =
        config.rewriteSemanticGuard === 'enforce' && proposal !== ''
          ? verifyRewrite(command, proposal)
          : undefined
      const suffix =
        guard === undefined
          ? ''
          : guard.ok
            ? ` (guard: accept — ${guard.via})`
            : ` (guard: reject — ${guard.reason})`
      note = `would rewrite to: ${proposal}${suffix}`
    } else {
      const first = (check.stderr || check.stdout).trim().split('\n')[0] ?? ''
      note = first === '' ? describeRun(check) : first
    }
    local.push(`rtk check  : ${note}`)
    return { kind: 'success', text: local.join('\n') }
  }

  async function forward(args: readonly string[], label: string): Promise<CommandOutcome> {
    const result = await run(binary, [...args], { timeoutMs: Math.max(context.timeoutMs, 5000), env: context.env })
    if (result.failure !== undefined) return { kind: 'error', text: `${label}: rtk did not run (${describeRun(result)})` }
    const text = (result.stdout + result.stderr).trim()
    if (result.code !== 0 && text === '') return { kind: 'error', text: `${label}: exit ${String(result.code)}` }
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
      case 'help':
        return {
          kind: 'success',
          text: rest[0] === undefined ? HELP : (HELP_TOPICS[rest[0]] ?? `unknown topic; try: ${Object.keys(HELP_TOPICS).join(', ')}`),
        }
      case 'status':
        return await status(invocation.agent)
      case 'stats': {
        const report = context.stats(invocation.agent)
        return { kind: 'success', text: rest.includes('--json') ? report.json : report.report }
      }
      case 'tools':
        return await tools(invocation.agent)
      case 'explain':
        return await explain(rest)
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
        if (target !== 'rewrite' && target !== 'compress' && target !== 'ui') {
          return { kind: 'error', text: 'usage: /rtk on|off rewrite|compress|ui' }
        }
        if (target === 'rewrite') config.rewriteEnabled = enabled
        else if (target === 'compress') config.compressEnabled = enabled
        else config.uiPill = enabled
        return { kind: 'success', text: `${target} ${flag(enabled)}` }
      }
      default:
        return { kind: 'success', text: HELP }
    }
  }

  return { handle }
}
