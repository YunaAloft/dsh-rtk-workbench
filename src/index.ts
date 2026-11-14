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
import { inspectPipeline, pipelineEnv, userPipelineCompresses } from './rtk/pipeline'
import { spillOriginal } from './rtk/spill'
import { createStats } from './stats'
import type { SessionRecord } from './stats'
import { createLifetimeStore, defaultStatsFile } from './stats-file'
import { commandOf, decideTool, isShellLike } from './toolmap'
import { createConnectionAdmission, mountStatusRoute, type ConnectionFence, type InjectingContext } from './web/status-route'

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

/** The slice of the Host settings service this plugin writes through. */
interface SettingsFormsLike {
  describe(): readonly { readonly ns: string; readonly revision: number }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** The Loader's `fiber.entry` augmentation, read structurally. */
interface FiberEntryLike {
  entry?: { options?: { id?: string } }
}

/** Cached outcome of the start-up capability probe. */
interface Capability {
  state: 'unknown' | 'ok' | 'fail'
  detail: string
  /** `rtk --version` output once the probe succeeded. */
  version: string
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
  // A shallow copy keeps runtime `/rtk on|off rewrite|compress` flips local to
  // this session. `uiPill` is a volatile config reference, so the copy shares the
  // same box: `/rtk off ui` persists through the Host instead of assigning here.
  const config: ConfigShape = { ...rawConfig }
  /**
   * Cross-restart counters. Counts, tool names and timestamps only (never
   * command text or output), loaded synchronously so early calls are not lost,
   * flushed in the background. The session map is read at flush time; the
   * holder breaks the creation order (the stats store is built after this one).
   */
  let sessionSource: (() => Record<string, SessionRecord>) | undefined
  const lifetime = createLifetimeStore({
    enabled: config.statsPersist === 'aggregate',
    file: defaultStatsFile(),
    sessions: () => sessionSource?.() ?? {},
  })
  lifetime.load()
  ctx.effect(() => () => {
    void lifetime.dispose()
  })
  const { env, configDir } = pipelineEnv(config.pipelineMode)
  /**
   * Live pipeline state. `mode` starts as what the config asked for, then `auto`
   * may flip it to `user` once the probe proves the user's pipeline compresses;
   * `health` is filled by the same probe.
   */
  const pipeline = {
    mode: (config.pipelineMode === 'user' ? 'user' : 'plugin-owned') as 'plugin-owned' | 'user',
    dir: configDir,
    health: 'unknown' as 'unknown' | 'ok' | 'problems',
    detail: undefined as string | undefined,
    trust: [] as string[],
  }
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
    version: '',
    probedAt: 0,
    probing: false,
    recall: 'unknown',
  }

  /**
   * Recall-store probe: a broken store does not stop compression, but it
   * silently removes the recovery path (rtk then omits its recall hint), so it
   * is worth one warning with the usual cause.
   */
  async function probeRecall(): Promise<void> {
    const budget = Math.max(config.timeoutMs, config.coldStartTimeoutMs)
    const probe = await runRtk(binary, ['recall', '--list'], { timeoutMs: budget, env, maxBytes: 64 * 1024 })
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
  }

  /**
   * Resolve `auto` and record the injected pipeline's health.
   *
   * A pipeline file that fails to resolve makes rtk fall back to `rtk:default`,
   * which has no `after_tool` rules: compression disappears while every switch
   * still says "on". That state must be visible, never silent.
   */
  async function settlePipeline(): Promise<void> {
    const budget = Math.max(config.timeoutMs, config.coldStartTimeoutMs)
    try {
      if (config.pipelineMode === 'auto') {
        const userCompresses = await userPipelineCompresses(binary, { env, timeoutMs: budget })
        if (userCompresses) {
          // `auto` starts from a fresh object (pipelineEnv copies the base env),
          // so dropping the override here is safe and affects every later spawn.
          delete env.RTK_CONFIG_DIR
          pipeline.mode = 'user'
          pipeline.dir = ''
        }
      }
      const health = await inspectPipeline(binary, { env, timeoutMs: budget })
      pipeline.health = health.ok ? 'ok' : 'problems'
      pipeline.detail = health.detail
      pipeline.trust = [...health.untrusted]
      if (!health.ok) {
        logger.warn?.(`[rtk-workbench] the injected pipeline is not active: ${health.detail ?? 'unknown reason'}`)
      } else if (pipeline.mode === 'user') {
        logger.info?.('[rtk-workbench] auto mode: using the user rtk pipeline (it already compresses)')
      }
    } catch {
      /* diagnostics must never break tool execution */
    }
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
      .then(async (run) => {
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
        capability.version = (run.stdout || run.stderr).trim()
        capability.detail = `${capability.version} (probe ${String(Date.now() - started)} ms)`
        logger.info?.(
          `[rtk-workbench] ${capability.detail} via ${resolution.source} — rewrite ${String(config.rewriteEnabled)}, compress ${String(config.compressEnabled)}`,
        )
        // A broken recall store does not stop compression, but it silently removes
        // the recovery path: rtk then omits its `[full output: rtk recall …]` hint,
        // so elided text is gone for good. Say so once, with the usual cause.
        if (config.compressEnabled) await probeRecall()
        await settlePipeline()
        registerAwareness()
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
      config.rewriteEnabled &&
      !rewritesBlockedBySandbox({
        platform: process.platform,
        guard: config.rewriteSandboxGuard,
        mode: sandboxMode(ctx, exec),
      }),
    retryOnRtkFailure: config.rewriteFallback === 'retry',
    cacheTtlMs: config.rewriteCacheTtlMs,
    semanticGuard: config.rewriteSemanticGuard === 'enforce',
    onRtkFailure: (exec) => {
      stats.recordError(exec, 'rtk')
      lifetime.record({ kind: 'fallback' })
    },
    onTimeout: (exec) => stats.recordError(exec, 'timeout'),
    onRewrite: (exec) => {
      stats.recordRewrite(exec)
      lifetime.record({ kind: 'rewrite' })
    },
    onGuardRejected: () => lifetime.record({ kind: 'guard' }),
  })
  ctx.effect(() => () => rewrites.dispose())

  let foreignTransforms = 0
  const debug = process.env.RTK_WORKBENCH_DEBUG === '1'
  const stats = createStats(lifetime.sessionsSnapshot())
  sessionSource = () => stats.serializeSessions()
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
    onCompressed: (exec, inBytes, outBytes, savedTokens, ms) => {
      stats.recordCompress(exec, inBytes, outBytes, savedTokens, ms)
      lifetime.record({ kind: 'compress', inBytes, outBytes, savedTokens })
    },
    onSkipped: (exec, reason) => stats.recordSkipped(exec, reason),
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
      // can replace `execute` underneath us. A shell-like name that no config
      // list names is still worth patching when discovery is on.
      const candidate = decision.rewrite || (config.discoverShellTools && isShellLike(exec.name))
      if (candidate && config.rewriteEnabled) rewrites.ensurePatched(exec.name, exec.agent)
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

  /**
   * Add the rtk prompt section — but only once the probe has proven that rtk
   * can actually compress. Telling the model "your output may be condensed"
   * when the binary is unusable is worse than saying nothing.
   */
  let awarenessRegistered = false
  function registerAwareness(): void {
    if (!config.awarenessEnabled || awarenessRegistered) return
    whenService<SystemPromptLike>(ctx, 'systemPrompt', (systemPrompt) => {
      if (awarenessRegistered) return
      awarenessRegistered = true
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

  // `client-connection` provides its service only after awaiting the browser
  // auth store, so sampling `ctx.get` during apply can capture `undefined` and
  // leave the status route permanently fail-closed (desktop and web profiles
  // both hit this). Wait for the service like `commands` above; admission
  // resolves the current value on every request.
  let connection: ConnectionFence | undefined
  whenService<ConnectionFence>(ctx, 'connection', (service) => {
    connection = service
  })

  // The command handler is built before the web route because `/doctor` on that
  // route reuses the same diagnostics; registering the command itself still
  // waits for the service.
  /**
   * Persist the pill switch into this plugin's profile entry. A volatile-only
   * write is committed into the running fiber without remounting, so the
   * session counters survive; the Host refuses a field shadowed by a higher
   * config layer, and that refusal is surfaced to the command.
   */
  async function persistUiPill(enabled: boolean): Promise<void> {
    const settings = ctx.get('settings') as SettingsFormsLike | undefined
    const entry = (ctx.fiber as unknown as FiberEntryLike).entry?.options?.id
    if (settings === undefined || entry === undefined) {
      throw new Error('no profile entry is available to save this switch')
    }
    const write = (): Promise<void> => {
      const view = settings.describe().find(row => row.ns === entry)
      return settings.update(entry, { uiPill: enabled }, view?.revision)
    }
    try {
      await write()
    } catch (error) {
      // A concurrent settings write bumped the revision; re-read it once.
      if ((error as { code?: string }).code !== 'SETTINGS_CONFLICT') throw error
      await write()
    }
  }

  const commandHandler = createCommandHandler({
      ctx,
      config,
      setUiPill: persistUiPill,
      binary,
      binarySource: resolution.source,
      pipeline: () => ({
        mode: pipeline.mode,
        dir: pipeline.dir,
        health: pipeline.health,
        ...(pipeline.detail === undefined ? {} : { detail: pipeline.detail }),
        trust: pipeline.trust,
      }),
      env,
      timeoutMs: config.timeoutMs,
      patched: () => rewrites.patchedList(),
      skipped: () => rewrites.skippedList(),
      stats: (agent: unknown) => {
        const key = stats.keyOfAgent(agent)
        const counters = {
          calls: rewrites.rewriteCount(),
          fallbacks: rewrites.fallbackCount(),
          learned: rewrites.learnedList(),
          guards: rewrites.guardCount(),
        }
        const totals = lifetime.snapshot()
        return {
          lines: stats.formatLines(key, counters, totals),
          report: stats.formatReport(key, counters, totals),
          json: stats.toJson(key, counters, totals),
          summary: stats.summary(key),
        }
      },
      lifetime: () => lifetime.snapshot(),
      rewrites: () => ({
        calls: rewrites.rewriteCount(),
        fallbacks: rewrites.fallbackCount(),
        learned: rewrites.learnedList(),
        guards: rewrites.guardCount(),
      }),
      foreignTransforms: () => foreignTransforms,
      capability: () => ({ state: capability.state, detail: capability.detail }),
      webRoute: () => ({ mounted: routeMounted, auth: connection === undefined ? 'fail-closed' : 'authenticated' }),
    })

  // The web UI reads this route; a headless profile has no webserver, so the
  // service simply never appears there.
  //
  // Admission reuses the host's client-connection fence (Host/Origin checks +
  // the signed browser cookie) instead of inventing a plugin token. Without
  // that service the route is fail-closed: the payload is only meaningful to
  // the authenticated local UI, and a missing fence is a composition problem
  // the doctor output should surface rather than silently serve around.
  const admit = createConnectionAdmission(() => connection)
  let routeMounted = false
  mountStatusRoute(ctx as Context & InjectingContext, {
    sources: {
      binary: () => ({ source: resolution.source, version: capability.version }),
      probe: () => ({ state: capability.state, detail: capability.detail }),
      pipeline: () => ({
        mode: pipeline.mode,
        health: pipeline.health,
        ...(pipeline.detail === undefined ? {} : { detail: pipeline.detail }),
      }),
      switches: () => ({
        rewrite: config.rewriteEnabled,
        compress: config.compressEnabled,
        awareness: config.awarenessEnabled,
        guard: config.rewriteSemanticGuard,
        deny: config.denyEnabled,
        ui: config.uiPill.get(),
      }),
      rewrites: () => ({
        calls: rewrites.rewriteCount(),
        fallbacks: rewrites.fallbackCount(),
        guards: rewrites.guardCount(),
        learned: rewrites.learnedList(),
      }),
      session: (key?: string) => stats.snapshot(key ?? stats.activeKey()),
      lifetime: () => lifetime.snapshot(),
      patched: () => rewrites.patchedList(),
      persist: () => ({ enabled: config.statsPersist === 'aggregate' }),
    },
    doctor: async () => {
      const outcome = await commandHandler.handle({ rawInput: 'doctor', agent: undefined })
      return outcome.text ?? ''
    },
    admit,
    onMounted: () => {
      routeMounted = true
    },
    log: (message: string) => logger.info?.(`[rtk-workbench] ${message}`),
  })

  whenService<CommandsLike>(ctx, 'commands', (commands) => {
    ctx.effect(() =>
      commands.register({
        definitionId: 'dsh-rtk-workbench',
        name: 'rtk',
        description: 'Inspect rtk, its switches and restore elided output.',
        input: { hint: 'status | tools | gain | recall <hash> | on|off rewrite|compress' },
        handler: (invocation) => commandHandler.handle(invocation),
      }),
    )
  })

  probeInBackground()
}
