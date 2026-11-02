import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from './config'

/**
 * Structural view of `ctx.workingDirectory` (`@deepseek-ai/dsh-working-directory`).
 * Kept structural so this plugin needs no hard package dependency.
 */
interface WorkingDirectoryLike {
  get(session: unknown): string
}

/** Structural view of `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`). */
interface SandboxPolicyLike {
  resolve(request: { session?: unknown }): { mode?: string }
}

/**
 * Modes in which the host may confine a tool's child processes. On Windows the
 * confinement denies a native binary (rtk.exe) the right to create its own
 * children, which is exactly what a rewritten command needs.
 */
const RESTRICTED_SANDBOX_MODES: ReadonlySet<string> = new Set(['read-only', 'workspace-write'])

/** The session object hanging off a tool execution, when there is one. */
function sessionOf(exec: Pick<ToolExecution, 'agent'>): unknown {
  const agent = exec.agent as { session?: unknown } | undefined
  return agent?.session
}

/**
 * The directory the current session works in.
 *
 * `exec.agent` carries a live Session at runtime (the same accessor
 * `dsh-tool-fs` uses through `ctx.workingDirectory.ensure`); the plugin's own
 * process cwd is the directory `dsh` was launched from, which is **not** the
 * session's project and makes rtk attribute every saving to the wrong project.
 *
 * @param ctx - plugin context (may or may not expose the working-directory service).
 * @param exec - the call being dispatched.
 * @returns an absolute directory; falls back to the host process cwd.
 */
export function sessionCwd(ctx: Context, exec: Pick<ToolExecution, 'agent'>): string {
  try {
    const service = ctx.get('workingDirectory') as WorkingDirectoryLike | undefined
    const session = sessionOf(exec)
    if (service !== undefined && session !== undefined) {
      const directory = service.get(session)
      if (typeof directory === 'string' && directory !== '') return directory
    }
  } catch {
    /* fall through to the process cwd */
  }
  return process.cwd()
}

/**
 * The `workdir` a shell tool call carries, when it has one.
 *
 * DSH's shell tools accept a per-call `workdir` (relative paths resolve against
 * the session directory) instead of `cd`; rtk must run in the directory the
 * command will actually execute in, not merely the session root.
 */
function workdirOf(exec: Pick<ToolExecution, 'arguments'>): string | undefined {
  const args = exec.arguments as Record<string, unknown> | null | undefined
  if (args === null || typeof args !== 'object') return undefined
  const value = args.workdir
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The directory the command of this call executes in.
 *
 * Prefers the call's own `workdir` (resolved against the session directory) and
 * falls back to the session directory itself.
 *
 * @param ctx - plugin context.
 * @param exec - the call being dispatched.
 */
export function callCwd(ctx: Context, exec: Pick<ToolExecution, 'agent' | 'arguments'>): string {
  const base = sessionCwd(ctx, exec)
  const workdir = workdirOf(exec)
  if (workdir === undefined) return base
  try {
    return isAbsolute(workdir) ? workdir : resolve(base, workdir)
  } catch {
    return base
  }
}

/**
 * The effective sandbox mode for one call, when the host exposes it.
 *
 * `ctx.sandboxPolicy.resolve({ session })` is the same resolver the shell and
 * filesystem backends use, so it reports the mode that will actually confine
 * this call — including a session override applied mid-session.
 *
 * @param ctx - plugin context.
 * @param exec - the call being dispatched.
 * @returns the mode name, or `undefined` when the service is absent.
 */
export function sandboxMode(ctx: Context, exec: Pick<ToolExecution, 'agent'>): string | undefined {
  try {
    const service = ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
    if (service === undefined) return undefined
    const session = sessionOf(exec)
    const mode = service.resolve(session === undefined ? {} : { session }).mode
    return typeof mode === 'string' ? mode : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the sandbox makes a rewrite a net negative for this call.
 *
 * Only Windows is guarded: there the confinement denies a non-shell binary the
 * right to spawn its own child, so `rtk <cmd>` fails before the real command
 * ever runs (`os error 5`). Linux/macOS confinement keeps process creation but
 * makes rtk's own store unwritable — that is the recall path, handled elsewhere.
 *
 * @param options - platform, the configured guard and the resolved mode.
 */
export function rewritesBlockedBySandbox(options: {
  readonly platform: string
  readonly guard: 'auto' | 'off'
  readonly mode: string | undefined
}): boolean {
  if (options.guard !== 'auto') return false
  if (options.platform !== 'win32') return false
  return options.mode !== undefined && RESTRICTED_SANDBOX_MODES.has(options.mode)
}

/**
 * The per-invocation budget to use right now.
 *
 * The first spawn in a fresh host process can take seconds while the platform
 * scans the unsigned binary; a 2 s budget would silently turn the very first
 * command into "no rewrite / no compression". Until the start-up probe settles
 * the call uses the cold-start budget instead.
 *
 * @param config - plugin config.
 * @param probe - the capability probe's current state.
 */
export function coldStartTimeout(
  config: Pick<Config, 'timeoutMs' | 'coldStartTimeoutMs'>,
  probe: 'unknown' | 'ok' | 'fail',
): number {
  return probe === 'unknown' ? Math.max(config.timeoutMs, config.coldStartTimeoutMs) : config.timeoutMs
}
