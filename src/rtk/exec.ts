import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundledRtkPath } from './bundled'

/** Why an invocation produced no usable answer. */
export interface RtkFailure {
  readonly kind: 'spawn' | 'timeout' | 'abort'
  readonly message: string
}

/** One rtk invocation's settled outcome. A run always settles; failure is data. */
export interface RtkRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Present when the child never completed (spawn error, timeout, abort). */
  readonly failure?: RtkFailure
}

/** Where the binary came from, for `/rtk status` and diagnostics. */
export type RtkSource = 'config' | 'env' | 'bundled' | 'path'

/** A resolved binary plus its provenance. */
export interface RtkResolution {
  readonly binary: string
  readonly source: RtkSource
}

/**
 * Make a configured binary path absolute.
 *
 * A relative path would resolve against whatever working directory the caller
 * happened to have — this plugin's spawn and the shell tool's rewritten command
 * are two different processes with two different cwds, so a relative path means
 * two different binaries. Anchoring it once removes that class of bug.
 *
 * @param candidate - the configured or environment-provided path.
 */
function anchorPath(candidate: string): string {
  const looksLikePath = candidate.includes('/') || candidate.includes('\\')
  return looksLikePath ? resolve(candidate) : candidate
}

/**
 * Resolve the rtk binary.
 *
 * Order: explicit config → `RTK_BIN`/`DSH_RTK_BIN` → the binary shipped with this
 * package → bare `rtk` on PATH. `rtkSource: 'path'` skips the bundled step, which
 * is what a user wants when they deliberately manage rtk themselves.
 *
 * @param options - `rtkPath` config and the `rtkSource` switch.
 * @param env - environment to read the overrides from.
 * @param platform - injectable for tests.
 * @param arch - injectable for tests.
 */
export function resolveRtk(
  options: { readonly rtkPath: string; readonly rtkSource: 'auto' | 'path' },
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): RtkResolution {
  const explicit = options.rtkPath.trim()
  if (explicit !== '') return { binary: anchorPath(explicit), source: 'config' }
  const fromEnv = (env.RTK_BIN ?? '').trim() || (env.DSH_RTK_BIN ?? '').trim()
  if (fromEnv !== '') return { binary: anchorPath(fromEnv), source: 'env' }
  if (options.rtkSource !== 'path') {
    const bundled = bundledRtkPath(platform, arch)
    if (bundled !== undefined) return { binary: bundled, source: 'bundled' }
  }
  return { binary: 'rtk', source: 'path' }
}

/** Whether a path-looking value exists on disk (bare names are left to PATH lookup). */
export function looksLikeMissingPath(binary: string): boolean {
  return (binary.includes('/') || binary.includes('\\')) && !existsSync(binary)
}

/** Render one settled run as one diagnostic line. */
export function describeRun(run: RtkRun): string {
  if (run.failure !== undefined) return `${run.failure.kind}: ${run.failure.message}`
  if (run.code !== 0) {
    const detail = run.stderr.trim().slice(0, 200)
    return `exit ${String(run.code)}${detail === '' ? '' : `: ${detail}`}`
  }
  return 'ok'
}

/**
 * Spawn rtk with an argv array (never a shell), write `input` to stdin, and
 * collect bounded output.
 *
 * Cancellation contract: callers pass the tool call's `AbortSignal`; on abort
 * or timeout the child is killed and the run settles with a `failure` so the
 * caller can fall back to the untouched behaviour. Nothing here throws — a
 * missing binary, a non-zero exit and a killed child all arrive as data.
 *
 * @param binary - resolved rtk path.
 * @param args - argv after the binary.
 * @param options - stdin payload, timeout, abort signal, extra environment.
 * @returns the run; check `failure` before trusting `code`/`stdout`.
 */
export async function runRtk(
  binary: string,
  args: readonly string[],
  options: {
    readonly input?: string
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
    readonly env?: NodeJS.ProcessEnv
    readonly maxBytes?: number
    /**
     * Working directory for the child. rtk records the project of a call from
     * its own process cwd (never from the hook payload), and project-scoped
     * pipeline / filter files resolve against it, so the directory the command
     * actually runs in is what makes attribution and project rules correct.
     */
    readonly cwd?: string
  } = {},
): Promise<RtkRun> {
  const { input = '', timeoutMs = 2000, signal, env = process.env, maxBytes = 8 * 1024 * 1024, cwd } = options
  const aborted: RtkRun = {
    code: null,
    stdout: '',
    stderr: '',
    failure: { kind: 'abort', message: 'the call was cancelled' },
  }
  if (signal?.aborted === true) return aborted

  return await new Promise<RtkRun>((resolve) => {
    let settled = false
    // Declared before `finish`: a synchronous `spawn` throw reaches `finish`
    // before the timer exists, and a `const` there would be a TDZ ReferenceError.
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const finish = (value: RtkRun): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
        ...(cwd === undefined ? {} : { cwd }),
        // `shell: false` is deliberate: the command string is data for rtk,
        // never something this process interpolates.
        shell: false,
      })
    } catch (error) {
      finish({ code: null, stdout: '', stderr: '', failure: { kind: 'spawn', message: String(error) } })
      return
    }

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let collected = 0

    onAbort = (): void => {
      child.kill()
      finish(aborted)
    }
    timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill()
            finish({
              code: null,
              stdout: '',
              stderr: '',
              failure: { kind: 'timeout', message: `no answer within ${String(timeoutMs)} ms` },
            })
          }, timeoutMs)
        : undefined
    timer?.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      collected += chunk.length
      if (collected <= maxBytes) chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errChunks.length < 64) errChunks.push(chunk)
    })
    // A child that exits before reading stdin (oversized payload, early bail)
    // makes the write fail with EPIPE; that is data, not an error.
    child.stdin?.on('error', () => {})
    child.on('error', (error: Error) => {
      finish({ code: null, stdout: '', stderr: '', failure: { kind: 'spawn', message: error.message } })
    })
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      })
    })

    try {
      child.stdin?.end(input)
    } catch {
      /* handled by the close/error paths above */
    }
  })
}
