import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { AWARENESS_ORDER, AWARENESS_SECTION_NAME, awarenessText, type SystemPromptLike } from './awareness'
import { createCommandHandler, type CommandsLike } from './commands'
import { createCompressLayer } from './compress-layer'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { createRewriteLayer } from './rewrite-layer'
import { callCwd, coldStartTimeout, rewritesBlockedBySandbox, sandboxMode } from './runtime'
import { describeRun, resolveRtk, runRtk } from './rtk/exec'
import { pipelineEnv } from './rtk/pipeline'
import { spillOriginal } from './rtk/spill'
import { commandOf, decideTool } from './toolmap'

export const name = 'dsh-rtk-workbench'

/**
 * `tools` is the only hard dependency: Cordis has no "optional inject" form (an
 * injected name is mandatory), so `commands` and `systemPrompt` are resolved
 * through `ctx.get(...)` and registered when they appear.
 */
export const inject = ['tools']

// Re-export the schema so the loader validates this plugin's config.
export { Config }

/** Minimal logger surface; absent loggers fall back to `console`. */
interface LoggerLike {
  info?(message: string): void
  warn?(message: string): void
}

/** Cached outcome of the start-up capability probe. */
interface Capability {
  state: 'unknown' | 'ok' | 'fail'
  detail: string
  probedAt: number
  probing: boolean
  /** Whether rtk's recall store is usable from this host (drives spill decisions). */
  recall: 'unknown' | 'ok' | 'fail'
}

/** How long a failed probe is trusted before a background re-probe. */
const RECHECK_AFTER_MS = 60_000

/**
 * Run `use` once a service is available, now or later.
 *
 * Registration must not assume load order: a profile can compose `commands`
 * after this plugin, and reading `ctx.get(name)` only at `apply` would then drop
 * the command group permanently.
 *
 * @param ctx - plugin context.
 * @param serviceName - service to wait for.
 * @param use - callback invoked exactly once with the live service.
 */
function whenService<T>(ctx: Context, serviceName: string, use: (service: T) => void): void {
  let used = false
  const run = (value: unknown): void => {
    if (used) return
    used = true
    use(value as T)
  }
  try {
    const existing = ctx.get(serviceName) as T | undefined
    if (existing !== undefined) {
      run(existing)
      return
    }
  } catch {
    /* fall through to the event */
  }
  ctx.on('internal/service', (registered: string, value: unknown) => {
    if (registered === serviceName) run(value)
  })
}

/**
 * Ask rtk whether this command is denied by its pipeline rules.
 *
 * Only called when `denyEnabled` is on (off by default: cc-safety-net already
 * owns command blocking). Any failure means "allow".
 */
async function denyVerdict(
  binary: string,
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  })
  const run = await runRtk(binary, ['hook', 'claude'], { input: payload, timeoutMs, env, signal, maxBytes: 64 * 1024 })
  if (run.failure !== undefined || run.code !== 0) return undefined
  const trimmed = run.stdout.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown }
    }
    const hook = parsed.hookSpecificOutput
    if (hook?.permissionDecision !== 'deny') return undefined
    return typeof hook.permissionDecisionReason === 'string' && hook.permissionDecisionReason !== ''
      ? hook.permissionDecisionReason
      : 'denied by an rtk pipeline rule'
  } catch {
    return undefined
  }
}

/**
 * Wire the three layers and the human-facing command group.
 *
 * @param ctx - plugin context.
 * @param rawConfig - validated plugin config.
 */
export function apply(ctx: Context, rawConfig: ConfigShape): void {
  // A mutable copy: `/rtk on|off` flips switches for this session without
  // rewriting the loader config (which is static after load).
  const config: ConfigShape = { ...rawConfig }
  const { env, configDir } = pipelineEnv(config.pipelineMode)
  const resolution = resolveRtk({ rtkPath: config.rtkPath, rtkSource: config.rtkSource }, env)
  const binary = resolution.binary

  const logger = ((): LoggerLike => {
    try {
      const service = ctx.get('logger') as LoggerLike | undefined
      if (service !== undefined) return service
    } catch {
      /* fall through */
    }
    return { info: (m: string) => console.info(m), warn: (m: string) => console.warn(m) }
  })()

  const capability: Capability = {
    state: 'unknown',
    detail: 'not probed yet',
    probedAt: 0,
    probing: false,
    recall: 'unknown',
  }

  /**
   * Probe the binary in the background.
   *
   * The first spawn in a fresh host process can take seconds (measured 2.7–5.8 s),
   * so the probe gets its own generous budget and never blocks a tool call.
   */
  function probeInBackground(): void {
    if (capability.probing) return
    capability.probing = true
    const budget = Math.max(config.timeoutMs, config.coldStartTimeoutMs)
    const started = Date.now()
    void runRtk(binary, ['--version'], { timeoutMs: budget, env })
      .then((run) => {
        if (run.failure !== undefined || run.code !== 0) {
          capability.state = 'fail'
          capability.detail = describeRun(run)
          const cold = run.failure?.kind === 'timeout' ? ' — the first spawn in a fresh host can be slow' : ''
          logger.warn?.(
            `[rtk-workbench] rtk is not usable at "${binary}" (${capability.detail})${cold}; rewrites and compression stay off`,
          )
          return
        }
        capability.state = 'ok'
        capability.detail = `${(run.stdout || run.stderr).trim()} (probe ${String(Date.now() - started)} ms)`
        logger.info?.(
          `[rtk-workbench] ${capability.detail} via ${resolution.source} — rewrite ${String(config.rewriteEnabled)}, compress ${String(config.compressEnabled)}`,
        )
        // A broken recall store does not stop compression, but it silently removes
        // the recovery path: rtk then omits its `[full output: rtk recall …]` hint,
        // so elided text is gone for good. Say so once, with the usual cause.
        if (!config.compressEnabled) return
        return runRtk(binary, ['recall', '--list'], { timeoutMs: budget, env, maxBytes: 64 * 1024 }).then((probe) => {
          if (probe.failure === undefined && probe.code === 0) {
            capability.recall = 'ok'
            return
          }
          capability.recall = 'fail'
          logger.warn?.(
            `[rtk-workbench] recall store unavailable (${describeRun(probe)}); compressed output will not be recoverable. ` +
              'This usually means the directory holding the binary refuses writes (a read-only mount or a restrictive ACL): ' +
              'install the platform tarball into the profile, or point `rtkPath` at an rtk outside that directory.',
          )
        })
      })
      .catch(() => {
        capability.state = 'fail'
        capability.detail = 'probe threw'
      })
      .finally(() => {
        capability.probing = false
        capability.probedAt = Date.now()
      })
  }


  const rewrites = createRewriteLayer({
    ctx,
    binary,
    timeoutMs: config.timeoutMs,
    env,
    excludeCommands: config.rewriteExcludeCommands,
    // rtk records the project (and resolves project-scoped rules) from its own
    // process cwd; the host's launch directory would be the wrong answer.
    cwdOf: (exec) => callCwd(ctx, exec),
    timeoutOf: () => coldStartTimeout(config, capability.state),
    // Windows + confined sandbox denies the wrapped command its own child
    // process, so a rewrite would only turn a working command into a failed one.
    allowRewrite: (exec) =>
      !rewritesBlockedBySandbox({
        platform: process.platform,
        guard: config.rewriteSandboxGuard,
        mode: sandboxMode(ctx, exec),
      }),
    retryOnRtkFailure: config.rewriteFallback === 'retry',
  })
  ctx.effect(() => () => rewrites.dispose())

  let foreignTransforms = 0
  const debug = process.env.RTK_WORKBENCH_DEBUG === '1'
  /**
   * Whether this call's compressed result needs the original text spilled.
   *
   * Three independent reasons: `always`, a confined sandbox (the model's shell
   * can read files but cannot write rtk's store, so `rtk recall` fails there),
   * a broken recall store, or rtk not having offered a recall hint at all.
   */
  const spillOf = async (
    exec: ToolExecution,
    text: string,
    offeredRecall: boolean,
  ): Promise<string | undefined> => {
    if (config.spillOriginal === 'off') return undefined
    const confined = rewritesBlockedBySandbox({
      platform: process.platform,
      guard: 'auto',
      mode: sandboxMode(ctx, exec),
    })
    const needed =
      config.spillOriginal === 'always' || confined || capability.recall === 'fail' || !offeredRecall
    if (!needed) return undefined
    return await spillOriginal(ctx, exec, text, config.maxSpillBytes)
  }
  const compression = createCompressLayer({
    binary,
    timeoutMs: config.timeoutMs,
    env,
    config,
    cwdOf: (exec) => callCwd(ctx, exec),
    timeoutOf: () => coldStartTimeout(config, capability.state),
    spillOf,
    onForeignTransform: () => {
      foreignTransforms += 1
    },
    ...(debug ? { log: (message: string) => logger.info?.(`[rtk-workbench] ${message}`) } : {}),
  })

  const preExecute = async (
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> => {
    try {
      const decision = decideTool(exec.name, config)
      // Patch on every dispatch: the definition may appear later, per-agent
      // restrictions mean the visible set differs by scope, and another plugin
      // can replace `execute` underneath us.
      if (decision.rewrite) rewrites.ensurePatched(exec.name, exec.agent)
      if (capability.state === 'fail' && Date.now() - capability.probedAt > RECHECK_AFTER_MS) probeInBackground()
      if (config.denyEnabled) {
        const command = commandOf(exec.arguments)
        if (command !== undefined) {
          const reason = await denyVerdict(binary, command, env, config.timeoutMs, exec.signal)
          if (reason !== undefined) return { kind: 'deny', reason }
        }
      }
    } catch {
      /* fail-open: never let the bridge decide anything on its own failure */
    }
    return await next()
  }

  const postExecute = async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    return await compression.listener(exec, result, next, rewrites.rewriteOf)
  }

  ctx.on('tools/pre-execute', preExecute)
  ctx.on('tools/post-execute', postExecute)

  if (config.awarenessEnabled) {
    whenService<SystemPromptLike>(ctx, 'systemPrompt', (systemPrompt) => {
      ctx.effect(() =>
        systemPrompt.section({
          name: AWARENESS_SECTION_NAME,
          order: AWARENESS_ORDER,
          text: awarenessText(),
          interpolate: false,
        }),
      )
    })
  }

  whenService<CommandsLike>(ctx, 'commands', (commands) => {
    const handler = createCommandHandler({
      ctx,
      config,
      binary,
      binarySource: resolution.source,
      pipelineMode: config.pipelineMode,
      pipelineDir: configDir,
      env,
      timeoutMs: config.timeoutMs,
      patched: () => rewrites.patchedList(),
      skipped: () => rewrites.skippedList(),
      foreignTransforms: () => foreignTransforms,
      capability: () => ({ state: capability.state, detail: capability.detail }),
    })
    ctx.effect(() =>
      commands.register({
        definitionId: 'dsh-rtk-workbench',
        name: 'rtk',
        description: 'Inspect rtk, its switches and restore elided output.',
        input: { hint: 'status | tools | gain | recall <hash> | on|off rewrite|compress' },
        handler: (invocation) => handler.handle(invocation),
      }),
    )
  })

  probeInBackground()
}
