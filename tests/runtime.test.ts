import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runRtk } from '../src/rtk/exec'
import { coldStartTimeout, callCwd, rewritesBlockedBySandbox, sandboxMode, sessionCwd } from '../src/runtime'

/** Minimal Context stand-in: every service lookup goes through `get(name)`. */
function fakeCtx(services: Record<string, unknown>): never {
  return { get: (name: string) => services[name] } as never
}

describe('session cwd', () => {
  it('asks the working-directory service for the calling session', () => {
    const ctx = fakeCtx({
      workingDirectory: { get: (session: unknown) => (session === 's1' ? '/ws/project' : '') },
    })
    expect(sessionCwd(ctx, { agent: { session: 's1' } } as never)).toBe('/ws/project')
  })

  it('falls back to the host process cwd without a service or a session', () => {
    expect(sessionCwd(fakeCtx({}), { agent: {} } as never)).toBe(process.cwd())
    expect(sessionCwd(fakeCtx({}), {} as never)).toBe(process.cwd())
  })

  it('never throws when a service is broken', () => {
    const ctx = {
      get: () => {
        throw new Error('boom')
      },
    } as never
    expect(sessionCwd(ctx, {} as never)).toBe(process.cwd())
  })
})

describe('call cwd', () => {
  const ctx = fakeCtx({ workingDirectory: { get: () => '/ws/project' } })
  const agent = { session: 's1' }

  it('prefers the call workdir, resolved against the session directory', () => {
    expect(callCwd(ctx, { agent, arguments: { workdir: 'sub/dir' } } as never)).toBe(resolve('/ws/project', 'sub/dir'))
    expect(callCwd(ctx, { agent, arguments: { workdir: '/elsewhere' } } as never)).toBe('/elsewhere')
  })

  it('falls back to the session directory without a usable workdir', () => {
    expect(callCwd(ctx, { agent, arguments: { command: 'ls' } } as never)).toBe('/ws/project')
    expect(callCwd(ctx, { agent, arguments: null } as never)).toBe('/ws/project')
    expect(callCwd(ctx, { agent, arguments: { workdir: 42 } } as never)).toBe('/ws/project')
  })
})

describe('sandbox awareness', () => {
  it('reads the mode the host will enforce for this session', () => {
    const ctx = fakeCtx({ sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } })
    expect(sandboxMode(ctx, { agent: { session: {} } } as never)).toBe('workspace-write')
  })

  it('reports no mode when the host does not expose the service', () => {
    expect(sandboxMode(fakeCtx({}), {} as never)).toBeUndefined()
  })

  it('guards rewrites only on Windows, only in confined modes, only on auto', () => {
    const base = { platform: 'win32', guard: 'auto' as const }
    expect(rewritesBlockedBySandbox({ ...base, mode: 'workspace-write' })).toBe(true)
    expect(rewritesBlockedBySandbox({ ...base, mode: 'read-only' })).toBe(true)
    expect(rewritesBlockedBySandbox({ ...base, mode: 'danger-full-access' })).toBe(false)
    expect(rewritesBlockedBySandbox({ ...base, mode: undefined })).toBe(false)
    expect(rewritesBlockedBySandbox({ ...base, guard: 'off', mode: 'workspace-write' })).toBe(false)
    expect(rewritesBlockedBySandbox({ platform: 'linux', guard: 'auto', mode: 'workspace-write' })).toBe(false)
  })
})

describe('cold start budget', () => {
  it('uses the larger budget until the probe settles', () => {
    const config = { timeoutMs: 2000, coldStartTimeoutMs: 8000 }
    expect(coldStartTimeout(config, 'unknown')).toBe(8000)
    expect(coldStartTimeout(config, 'ok')).toBe(2000)
    expect(coldStartTimeout(config, 'fail')).toBe(2000)
  })
})

describe('runRtk working directory', () => {
  it('spawns the child in the requested directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rtk-cwd-'))
    try {
      const run = await runRtk(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
        cwd: directory,
        timeoutMs: 10_000,
      })
      expect(run.failure).toBeUndefined()
      expect(run.code).toBe(0)
      expect(realpathSync(run.stdout.trim()).toLowerCase()).toBe(realpathSync(directory).toLowerCase())
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
