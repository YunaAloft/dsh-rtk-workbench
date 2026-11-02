import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { runRtk } from './rtk/exec'
import {
  absolutizeRtk,
  decideRewrite,
  isWorthRewriting,
  looksLikeRtkFailure,
  resultText,
  verbOf,
} from './rtk/rewrite'
import { commandOf, dialectOf } from './toolmap'

/** One applied rewrite, recorded so the result can state what actually ran. */
export interface AppliedRewrite {
  readonly from: string
  readonly to: string
  /**
   * True when the rewritten command was abandoned and the original ran instead.
   * The annotator must say "fell back", never "ran", in that case.
   */
  readonly fallback?: boolean
}

/** Everything the rewrite layer needs from the surrounding plugin. */
export interface RewriteLayerOptions {
  readonly ctx: Context
  readonly binary: string
  readonly timeoutMs: number
  readonly env: NodeJS.ProcessEnv
  /** Command words that must not justify a rewrite (default: none). */
  readonly excludeCommands?: readonly string[]
  /**
   * Session directory for this call. rtk records the project of a rewrite from
   * its own process cwd and resolves project-scoped rules against it, so the
   * host's launch directory would be the wrong answer.
   */
  readonly cwdOf?: (exec: ToolRunContext) => string | undefined
  /** Per-call budget (the cold-start budget applies until the probe settles). */
  readonly timeoutOf?: () => number
  /**
   * Whether this call may be rewritten at all. The sandbox guard uses it to
   * skip rewrites the host would refuse to let rtk spawn.
   */
  readonly allowRewrite?: (exec: ToolRunContext) => boolean
  /** Retry the original command when rtk itself failed. Defaults to `true`. */
  readonly retryOnRtkFailure?: boolean
  /** Called once per rtk-side failure (spawn/run), for session counters. */
  readonly onRtkFailure?: (exec: ToolRunContext) => void
  /** Called once per rtk timeout, for session counters. */
  readonly onTimeout?: (exec: ToolRunContext) => void
  /** Injectable runner, so unit tests can simulate rtk failures without a binary. */
  readonly run?: typeof runRtk
}

/** One wrapped `execute`, tracked per definition object. */
interface PatchState {
  readonly wrapped: (args: unknown, exec: ToolRunContext) => Promise<unknown>
  readonly original: (...args: never[]) => unknown
}

/** Serialised results above this size are never treated as an rtk-side failure. */
const FAILURE_INSPECT_LIMIT = 8 * 1024

/**
 * Rewrite layer: wrap `ToolDefinition.execute` in place so a shell call runs the
 * rtk-rewritten command, and fall back to the original command when rtk itself
 * failed to run it.
 *
 * Why patching rather than re-dispatching from `tools/execute`: the registry's
 * `dispatchToolBody` fuses the caller signal and records `bodyInvoked` before
 * invoking the body. A listener that skips `next()` and calls `execute` itself
 * loses both. Patching leaves that machinery intact and substitutes one argument.
 *
 * Three properties matter for correctness:
 *
 * - **Per definition, not per name.** `ctx.tools.get(name, scope)` can return
 *   different objects for different agent scopes, so the cache is keyed by the
 *   definition object.
 * - **Verified on every call.** Another plugin (or a reload of this one) can
 *   replace `execute` underneath us; the next call re-wraps when it no longer
 *   sees our wrapper, instead of silently losing rewrites.
 * - **A failed rewrite must not turn a working command into a broken one.** When
 *   the result carries rtk's own spawn/run failure signature, the original
 *   command is executed once and the verb is suppressed for the rest of the
 *   session (the environment has proven it cannot run it).
 */
export function createRewriteLayer(options: RewriteLayerOptions) {
  const { ctx, binary, timeoutMs, env } = options
  const exclude = new Set(options.excludeCommands ?? [])
  const retryOnRtkFailure = options.retryOnRtkFailure ?? true
  /** Rewrites applied to one execution, read back by the post-execute annotator. */
  const applied = new WeakMap<object, AppliedRewrite>()
  /** definition object → the wrapper currently installed on it. */
  const patches = new WeakMap<object, PatchState>()
  const patchedNames = new Set<string>()
  const skipped = new Map<string, string>()
  const restores: Array<() => void> = []
  /** Verbs whose rewritten form failed at rtk's own layer; never rewritten again this session. */
  const learned = new Set<string>()
  let fallbacks = 0
  let rewrites = 0

  /**
   * Whether the settled result is rtk failing to run the command it wraps.
   *
   * Bounded on purpose: a command that legitimately prints an "rtk:" line and
   * fails must not be replayed, so the inspection refuses results large enough
   * to be real output rather than rtk's one-line diagnostic.
   *
   * @param result - whatever the wrapped `execute` returned.
   */
  function isRtkFailure(result: unknown): boolean {
    const text = resultText(result)
    return text.length > 0 && text.length < FAILURE_INSPECT_LIMIT && looksLikeRtkFailure(text)
  }

  /**
   * Patch one tool definition if it is a shell eligible for rewriting.
   *
   * Idempotent and self-healing: safe to call on every dispatch.
   *
   * @param name - tool name at dispatch time.
   * @param scope - the calling agent, so per-agent restrictions resolve correctly.
   */
  function ensurePatched(name: string, scope: unknown): void {
    let definition: ToolDefinition | undefined
    try {
      definition = ctx.tools.get(name, scope as never)
    } catch {
      return
    }
    if (definition === undefined) return

    const state = patches.get(definition)
    if (state !== undefined && definition.execute === state.wrapped) {
      patchedNames.add(name)
      return
    }
    if (state === undefined && skipped.has(name)) return

    const original = definition.execute
    if (typeof original !== 'function') return
    const descriptor = Object.getOwnPropertyDescriptor(definition, 'execute')
    if (descriptor === undefined || !descriptor.writable) {
      skipped.set(name, 'the definition is not writable')
      return
    }

    const owner = definition
    const dialect = dialectOf(name)
    const runner = options.run ?? runRtk
    const wrapped = async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      const command = commandOf(args)
      if (command === undefined || !isWorthRewriting(command, dialect, exclude)) {
        return await original.call(owner, args, exec)
      }
      const verb = verbOf(command)
      // The environment already proved it cannot run rtk for this verb: skip the
      // ~206 ms spawn instead of paying it for a guaranteed failure.
      if (verb !== undefined && learned.has(verb)) return await original.call(owner, args, exec)
      if (options.allowRewrite !== undefined && !options.allowRewrite(exec)) {
        return await original.call(owner, args, exec)
      }
      const cwd = options.cwdOf?.(exec)
      const run = await runner(binary, ['rewrite', command], {
        timeoutMs: options.timeoutOf?.() ?? timeoutMs,
        signal: exec.signal,
        env,
        maxBytes: 64 * 1024,
        ...(cwd === undefined ? {} : { cwd }),
      })
      if (run.failure?.kind === 'timeout') options.onTimeout?.(exec)
      const outcome = decideRewrite(command, run.failure === undefined ? run : null)
      if (outcome.kind !== 'rewrite') return await original.call(owner, args, exec)
      // rtk answers with a bare `rtk …`; a bundled-only install has no such PATH
      // entry, so run the binary this plugin resolved.
      const target = absolutizeRtk(outcome.command, binary, dialect)
      applied.set(exec, { from: command, to: target })
      rewrites += 1
      let result: unknown
      try {
        const next = { ...(args as Record<string, unknown>), command: target }
        result = await original.call(owner, next, exec)
      } catch (error) {
        // The body may have started with the rewritten command; report the same
        // failure the ordinary path would have produced and do not retry.
        applied.delete(exec)
        throw error
      }
      if (!retryOnRtkFailure || verb === undefined || !isRtkFailure(result)) return result

      // rtk itself failed (spawn denied / binary unusable). The original command
      // never ran, so run it now and stop rewriting this verb for the session.
      learned.add(verb)
      fallbacks += 1
      options.onRtkFailure?.(exec)
      applied.set(exec, { from: command, to: target, fallback: true })
      return await original.call(owner, args, exec)
    }

    try {
      definition.execute = wrapped
      if (ctx.tools.get(name, scope as never)?.execute !== wrapped) {
        definition.execute = original
        skipped.set(name, 'the registry does not dispatch the object we patched')
        return
      }
    } catch {
      try {
        definition.execute = original
      } catch {
        /* best effort */
      }
      skipped.set(name, 'patching threw')
      return
    }

    patches.set(definition, { wrapped, original })
    patchedNames.add(name)
    skipped.delete(name)
    restores.push(() => {
      try {
        if (definition !== undefined && definition.execute === wrapped) definition.execute = original
      } catch {
        /* the registry may already have dropped this definition */
      }
    })
  }

  /** The rewrite applied to this execution, or `undefined`. */
  function rewriteOf(exec: object): AppliedRewrite | undefined {
    return applied.get(exec)
  }

  /** Undo every patch, newest first. */
  function dispose(): void {
    for (const restore of restores.reverse()) restore()
    restores.length = 0
    patchedNames.clear()
  }

  /** Tool names that currently carry our wrapper (for `/rtk tools`). */
  function patchedList(): string[] {
    return [...patchedNames]
  }

  /** Tool names skipped by a guard, with the reason (for `/rtk status`). */
  function skippedList(): ReadonlyMap<string, string> {
    return skipped
  }

  /** Verbs suppressed after rtk failed to run them (for `/rtk status`). */
  function learnedList(): string[] {
    return [...learned]
  }

  /** How many rewrites were abandoned and replayed as the original command. */
  function fallbackCount(): number {
    return fallbacks
  }

  /** How many rewritten commands were dispatched. */
  function rewriteCount(): number {
    return rewrites
  }

  return {
    ensurePatched,
    rewriteOf,
    dispose,
    patchedList,
    skippedList,
    learnedList,
    fallbackCount,
    rewriteCount,
  }
}
