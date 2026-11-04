import { describe, expect, it, vi } from 'vitest'
import {
  buildStatusPayload,
  createStatusHandler,
  mountStatusRoute,
  STATUS_ROUTE_PATH,
  type MountOptions,
  type StatusSources,
} from '../src/web/status-route'

/** Minimal response recorder standing in for `node:http`. */
function recorder() {
  const state: { status: number; headers: Record<string, unknown>; body: string } = {
    status: 0,
    headers: {},
    body: '',
  }
  const response = {
    writeHead(status: number, headers: Record<string, unknown>) {
      state.status = status
      state.headers = headers
    },
    end(body: string) {
      state.body = body
    },
  } as never
  return { response, state }
}

/** Minimal request standing in for `node:http`. */
function request(url: string, method = 'GET'): never {
  return {
    url,
    method,
    on: () => undefined,
  } as never
}

function sources(overrides: Partial<StatusSources> = {}): StatusSources {
  return {
    binary: () => ({ source: 'bundled', version: 'rtk 1.1.0' }),
    probe: () => ({ state: 'ok', detail: 'probe ok' }),
    pipeline: () => ({ mode: 'plugin-owned', health: 'ok' }),
    switches: () => ({ rewrite: true, compress: true, awareness: true, guard: 'enforce', deny: false, ui: true }),
    rewrites: () => ({ calls: 2, fallbacks: 0, guards: 1, learned: [] }),
    session: () => undefined,
    lifetime: () => undefined,
    patched: () => ['bash'],
    persist: () => ({ enabled: true }),
    ...overrides,
  }
}

function handler(overrides: Partial<MountOptions> = {}) {
  return createStatusHandler({
    sources: sources(),
    doctor: async () => 'rtk-workbench doctor\nplatform   : win32 x64',
    ...overrides,
  })
}

describe('buildStatusPayload', () => {
  it('maps every source and nulls the absent ones', () => {
    const payload = buildStatusPayload(sources(), 1_760_000_000_000)
    expect(payload.ok).toBe(true)
    expect(payload.updatedAt).toBe(new Date(1_760_000_000_000).toISOString())
    expect(payload.binary.source).toBe('bundled')
    expect(payload.session).toBeNull()
    expect(payload.lifetime).toBeNull()
    expect(payload.patched).toEqual(['bash'])
    expect(payload.persist.enabled).toBe(true)
  })

  it('never leaks a pipeline detail field it did not receive', () => {
    const payload = buildStatusPayload(sources())
    expect(Object.hasOwn(payload.pipeline, 'detail')).toBe(false)
  })
})

describe('status route', () => {
  it('serves GET /status as JSON with no-store', async () => {
    const { response, state } = recorder()
    await handler()(request(`${STATUS_ROUTE_PATH}/status`), response)
    expect(state.status).toBe(200)
    expect(state.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(state.body) as { ok: boolean; binary: { version: string } }
    expect(body.ok).toBe(true)
    expect(body.binary.version).toBe('rtk 1.1.0')
  })

  it('serves POST /doctor with the diagnostic text', async () => {
    const { response, state } = recorder()
    await handler()(request(`${STATUS_ROUTE_PATH}/doctor`, 'POST'), response)
    expect(state.status).toBe(200)
    expect((JSON.parse(state.body) as { text: string }).text).toContain('doctor')
  })

  it('answers 404 for anything else and 500 when the doctor throws', async () => {
    const missing = recorder()
    await handler()(request(`${STATUS_ROUTE_PATH}/nope`), missing.response)
    expect(missing.state.status).toBe(404)

    const failing = recorder()
    await handler({
      doctor: async () => {
        throw new Error('spawn failed')
      },
    })(request(`${STATUS_ROUTE_PATH}/doctor`, 'POST'), failing.response)
    expect(failing.state.status).toBe(500)
    expect((JSON.parse(failing.state.body) as { error: string }).error).toBe('spawn failed')
  })

  it('accepts a custom prefix', async () => {
    const { response, state } = recorder()
    await createStatusHandler({ path: '/x/custom/', sources: sources(), doctor: async () => '' })(
      request('/x/custom/status'),
      response,
    )
    expect(state.status).toBe(200)
  })
})

describe('mountStatusRoute', () => {
  it('registers a prefix route and unregisters it on disposal', () => {
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const disposers: Array<() => void> = []
    const inject = vi.fn((_deps: readonly string[], plugin: (scope: unknown) => void) => {
      plugin({
        webServer: { register },
        effect: (registerDisposal: () => () => void) => {
          disposers.push(registerDisposal())
        },
      })
    })

    mountStatusRoute({ inject } as never, { sources: sources(), doctor: async () => '' })

    expect(inject).toHaveBeenCalledWith(['webServer'], expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'prefix', path: STATUS_ROUTE_PATH, handler: expect.any(Function) }),
    )
    expect(disposers).toHaveLength(1)
    disposers[0]?.()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the profile has no webserver', () => {
    const inject = vi.fn((_deps: readonly string[], plugin: (scope: unknown) => void) => {
      plugin({})
    })
    expect(() => mountStatusRoute({ inject } as never, { sources: sources(), doctor: async () => '' })).not.toThrow()
  })
})
