import { describe, expect, it, vi } from 'vitest'
import { createRewriteLayer } from '../src/rewrite-layer'
import type { RtkRun } from '../src/rtk/exec'

type Definition = { name: string; execute: (...args: never[]) => unknown; [key: string]: unknown }

/** Fake registry exposing exactly one definition under one name. */
function fakeCtx(definition: Definition): never {
  return {
    tools: {
      get: (name: string) => (name === definition.name ? definition : undefined),
    },
  } as never
}

function definition(name: string, impl: (args: { command: string }) => unknown): Definition {
  return { name, execute: impl as unknown as (...args: never[]) => unknown }
}

/** Invoke a wrapped definition with a minimal ToolRunContext. */
async function invoke(candidate: Definition, args: unknown): Promise<unknown> {
  const fn = candidate.execute as unknown as (a: unknown, e: unknown) => Promise<unknown>
  return await fn(args, {})
}

/** A runner that answers every `rtk rewrite` with the same rewritten command. */
function rewriteRunner(target: string) {
  return vi.fn(
    async (_binary: string, args: readonly string[]): Promise<RtkRun> =>
      args[0] === 'rewrite' ? { code: 0, stdout: target, stderr: '' } : { code: 1, stdout: '', stderr: '' },
  )
}

const SPAWN_FAILURE = 'rtk: Failed to run ls: Failed to spawn process: 拒绝访问 (os error 5)'

describe('rewrite fallback', () => {
  it('replays the original command when rtk itself failed, then suppresses that verb', async () => {
    const seen: string[] = []
    const candidate = definition('bash', (args) => {
      seen.push(args.command)
      return args.command.startsWith('rtk ')
        ? { stdout: '', stderr: SPAWN_FAILURE, exitCode: 1 }
        : { stdout: 'real output', exitCode: 0 }
    })
    const layer = createRewriteLayer({
      ctx: fakeCtx(candidate),
      binary: 'rtk',
      timeoutMs: 100,
      env: {},
      run: rewriteRunner('rtk ls -la'),
    })
    layer.ensurePatched('bash', undefined)

    const first = await invoke(candidate, { command: 'ls -la' })
    expect(seen).toEqual(['rtk ls -la', 'ls -la'])
    expect(first).toMatchObject({ stdout: 'real output' })
    expect(layer.learnedList()).toEqual(['ls'])
    expect(layer.fallbackCount()).toBe(1)

    // The verb is suppressed now: no second rtk rewrite, straight to the original.
    await invoke(candidate, { command: 'ls -la' })
    expect(seen).toEqual(['rtk ls -la', 'ls -la', 'ls -la'])
    layer.dispose()
  })

  it('does not replay a command that merely failed on its own', async () => {
    const seen: string[] = []
    const candidate = definition('bash', (args) => {
      seen.push(args.command)
      return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
    })
    const layer = createRewriteLayer({
      ctx: fakeCtx(candidate),
      binary: 'rtk',
      timeoutMs: 100,
      env: {},
      run: rewriteRunner('rtk git status'),
    })
    layer.ensurePatched('bash', undefined)
    await invoke(candidate, { command: 'git status' })
    expect(seen).toEqual(['rtk git status'])
    expect(layer.learnedList()).toEqual([])
    expect(layer.fallbackCount()).toBe(0)
    layer.dispose()
  })

  it('honours rewriteFallback: off', async () => {
    const seen: string[] = []
    const candidate = definition('bash', (args) => {
      seen.push(args.command)
      return args.command.startsWith('rtk ') ? { stdout: '', stderr: SPAWN_FAILURE, exitCode: 1 } : 'ok'
    })
    const layer = createRewriteLayer({
      ctx: fakeCtx(candidate),
      binary: 'rtk',
      timeoutMs: 100,
      env: {},
      retryOnRtkFailure: false,
      run: rewriteRunner('rtk ls -la'),
    })
    layer.ensurePatched('bash', undefined)
    const result = await invoke(candidate, { command: 'ls -la' })
    expect(seen).toEqual(['rtk ls -la'])
    expect(result).toMatchObject({ stderr: SPAWN_FAILURE })
    layer.dispose()
  })

  it('does not consult rtk when the call is not allowed (sandbox guard)', async () => {
    const seen: string[] = []
    const candidate = definition('bash', (args) => {
      seen.push(args.command)
      return 'ok'
    })
    const run = rewriteRunner('rtk ls -la')
    const layer = createRewriteLayer({
      ctx: fakeCtx(candidate),
      binary: 'rtk',
      timeoutMs: 100,
      env: {},
      allowRewrite: () => false,
      run,
    })
    layer.ensurePatched('bash', undefined)
    await invoke(candidate, { command: 'ls -la' })
    expect(run).not.toHaveBeenCalled()
    expect(seen).toEqual(['ls -la'])
    layer.dispose()
  })

  it('passes the session cwd and the cold-start budget to rtk', async () => {
    const calls: Array<{ timeoutMs?: number; cwd?: string }> = []
    const run = vi.fn(async (_binary: string, args: readonly string[], options?: { timeoutMs?: number; cwd?: string }) => {
      calls.push({ timeoutMs: options?.timeoutMs, cwd: options?.cwd })
      return { code: args[0] === 'rewrite' ? 0 : 1, stdout: 'rtk ls -la', stderr: '' } as RtkRun
    })
    const candidate = definition('bash', () => 'ok')
    const layer = createRewriteLayer({
      ctx: fakeCtx(candidate),
      binary: 'rtk',
      timeoutMs: 2000,
      env: {},
      cwdOf: () => '/ws/project',
      timeoutOf: () => 8000,
      run,
    })
    layer.ensurePatched('bash', undefined)
    await invoke(candidate, { command: 'ls -la' })
    expect(calls[0]).toEqual({ timeoutMs: 8000, cwd: '/ws/project' })
    layer.dispose()
  })
})
