import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { runRtk } from './rtk/exec'
import { absolutizeRtk, decideRewrite, isWorthRewriting } from './rtk/rewrite'
import { commandOf, dialectOf } from './toolmap'

/** One applied rewrite, recorded so the result can state what actually ran. */
export interface AppliedRewrite {
  readonly from: string
  readonly to: string
}

/** Everything the rewrite layer needs from the surrounding plugin. */
export interface RewriteLayerOptions {
  readonly ctx: Context
  readonly binary: string
  readonly timeoutMs: number
  readonly env: NodeJS.ProcessEnv
  /** Command words that must not justify a rewrite (default: none). */
  readonly excludeCommands?: readonly string[]
}

/** One wrapped `execute`, tracked per definition object. */
interface PatchState {
  readonly wrapped: (args: unknown, exec: ToolRunContext) => Promise<unknown>
  readonly original: (...args: never[]) => unknown
}

/**
 * Rewrite layer: wrap `ToolDefinition.execute` in place so a shell call runs the
 * rtk-rewritten command.
 *
 * Why patching rather than re-dispatching from `tools/execute`: the registry's
 * `dispatchToolBody` fuses the caller signal and records `bodyInvoked` before
 * invoking the body. A listener that skips `next()` and calls `execute` itself
 * loses both. Patching leaves that machinery intact and substitutes one argument.
 *
 * Two properties matter for correctness:
 *
 * - **Per definition, not per name.** `ctx.tools.get(name, scope)` can return
 *   different objects for different agent scopes, so the cache is keyed by the
 *   definition object.
 * - **Verified on every call.** Another plugin (or a reload of this one) can
 *   replace `execute` underneath us; the next call re-wraps when it no longer
 *   sees our wrapper, instead of silently losing rewrites.
 */
export function createRewriteLayer(options: RewriteLayerOptions) {
  const { ctx, binary, timeoutMs, env } = options
  const exclude = new Set(options.excludeCommands ?? [])
  /** Rewrites applied to one execution, read back by the post-execute annotator. */
  const applied = new WeakMap<object, AppliedRewrite>()
  /** definition object → the wrapper currently installed on it. */
  const patches = new WeakMap<object, PatchState>()
  const patchedNames = new Set<string>()
  const skipped = new Map<string, string>()
  const restores: Array<() => void> = []

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
    const wrapped = async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
      const command = commandOf(args)
      if (command === undefined || !isWorthRewriting(command, dialect, exclude)) {
        return await original.call(owner, args, exec)
      }
      const run = await runRtk(binary, ['rewrite', command], {
        timeoutMs,
        signal: exec.signal,
        env,
        maxBytes: 64 * 1024,
      })
      const outcome = decideRewrite(command, run.failure === undefined ? run : null)
      if (outcome.kind !== 'rewrite') return await original.call(owner, args, exec)
      // rtk answers with a bare `rtk …`; a bundled-only install has no such PATH
      // entry, so run the binary this plugin resolved.
      const target = absolutizeRtk(outcome.command, binary, dialect)
      applied.set(exec, { from: command, to: target })
      try {
        const next = { ...(args as Record<string, unknown>), command: target }
        return await original.call(owner, next, exec)
      } catch (error) {
        // The body may have started with the rewritten command; report the same
        // failure the ordinary path would have produced and do not retry.
        applied.delete(exec)
        throw error
      }
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

  return { ensurePatched, rewriteOf, dispose, patchedList, skippedList }
}
