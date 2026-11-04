/**
 * Read-only HTTP surface for the web UI.
 *
 * The browser half cannot read host memory, and an external package cannot add
 * a `ctx.remote` endpoint (that needs the repository's typert generation), so a
 * plain webserver prefix route is the only supported data path. It is mounted
 * only when the profile runs a web carrier; a headless profile simply has no UI.
 *
 * The payload is deliberately counts and enums only: no command text, no tool
 * output, no filesystem paths. A local page already sees those in the transcript;
 * an endpoint that repeats them would widen the surface for nothing.
 *
 * @module dsh-rtk-workbench/web/status-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionSnapshot } from '../stats'
import type { LifetimeTotals } from '../stats-file'

/** Where the rtk binary came from, and what it answers to `--version`. */
export interface BinaryInfo {
  readonly source: string
  readonly version: string
}

/** Start-up capability probe outcome. */
export interface ProbeInfo {
  readonly state: 'unknown' | 'ok' | 'fail'
  readonly detail: string
}

/** Which pipeline runs and whether it is healthy. */
export interface PipelineInfo {
  readonly mode: 'plugin-owned' | 'user'
  readonly health: 'unknown' | 'ok' | 'problems'
  readonly detail?: string
}

/** The switches a user can flip, as currently effective. */
export interface SwitchInfo {
  readonly rewrite: boolean
  readonly compress: boolean
  readonly awareness: boolean
  readonly guard: 'enforce' | 'off'
  readonly deny: boolean
  /** Whether the web GUI should show the savings pill. */
  readonly ui: boolean
}

/** Rewrite counters owned by the rewrite layer. */
export interface RewriteInfo {
  readonly calls: number
  readonly fallbacks: number
  readonly guards: number
  readonly learned: readonly string[]
}

/** Everything the payload is built from. */
export interface StatusSources {
  readonly binary: () => BinaryInfo
  readonly probe: () => ProbeInfo
  readonly pipeline: () => PipelineInfo
  readonly switches: () => SwitchInfo
  readonly rewrites: () => RewriteInfo
  /** The most recently active session, or `undefined` before any tool ran. */
  readonly session: () => SessionSnapshot | undefined
  readonly lifetime: () => LifetimeTotals | undefined
  readonly patched: () => readonly string[]
  readonly persist: () => { readonly enabled: boolean }
}

/** One JSON document served at `GET <prefix>/status`. */
export interface StatusPayload {
  readonly ok: true
  readonly updatedAt: string
  readonly binary: BinaryInfo
  readonly probe: ProbeInfo
  readonly pipeline: PipelineInfo
  readonly switches: SwitchInfo
  readonly rewrites: RewriteInfo
  readonly session: SessionSnapshot | null
  readonly lifetime: LifetimeTotals | null
  readonly patched: readonly string[]
  readonly persist: { readonly enabled: boolean }
}

/**
 * Build the status document from the live plugin state.
 *
 * @param sources - accessors for every reported fact.
 * @param now - clock override for tests.
 */
export function buildStatusPayload(sources: StatusSources, now: number = Date.now()): StatusPayload {
  const pipeline = sources.pipeline()
  return {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    binary: sources.binary(),
    probe: sources.probe(),
    pipeline: {
      mode: pipeline.mode,
      health: pipeline.health,
      ...(pipeline.detail === undefined ? {} : { detail: pipeline.detail }),
    },
    switches: sources.switches(),
    rewrites: sources.rewrites(),
    session: sources.session() ?? null,
    lifetime: sources.lifetime() ?? null,
    patched: [...sources.patched()],
    persist: sources.persist(),
  }
}

/** Minimal structural view of a `node:http` request/response pair. */
type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/** Structural view of the host's webserver service (see `packages/host/webserver`). */
export interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: Handler
  }): () => void
}

/** The scoped context handed to an `inject(['webServer'], …)` callback. */
export interface WebServerScope {
  readonly webServer?: WebServerLike
  readonly effect?: (register: () => () => void) => void
}

/** The slice of the host context this module needs. */
export interface InjectingContext {
  inject(deps: readonly string[], plugin: (scope: WebServerScope) => void): void
}

/** Options for {@link mountStatusRoute}. */
export interface MountOptions {
  /** Prefix route; `/status` and `/doctor` hang below it. */
  readonly path?: string
  readonly sources: StatusSources
  /** Runs the same diagnostics as `/rtk doctor` on demand. */
  readonly doctor: () => Promise<string>
  readonly log?: (message: string) => void
}

/** Default prefix. */
export const STATUS_ROUTE_PATH = '/api/rtk-workbench'

/** Answer one request with JSON and no caching. */
function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Reject cross-origin and oversized doctor calls early. */
const MAX_DOCTOR_BODY = 4 * 1024

/**
 * Create the prefix handler.
 *
 * @param options - route prefix, payload sources and the doctor entry point.
 * @returns a handler for the host webserver.
 */
export function createStatusHandler(options: MountOptions): Handler {
  const prefix = (options.path ?? STATUS_ROUTE_PATH).replace(/\/+$/, '')
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(prefix.length).replace(/\/+$/, '') || '/'
    const method = (request.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET' && route === '/status') {
        send(response, 200, buildStatusPayload(options.sources))
        return
      }
      if (method === 'POST' && route === '/doctor') {
        // Nothing is read from the body; draining it keeps keep-alive honest.
        let size = 0
        request.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_DOCTOR_BODY) request.destroy()
        })
        const text = await options.doctor()
        send(response, 200, { ok: true, text })
        return
      }
      if (method === 'OPTIONS') {
        response.writeHead(204, { allow: 'GET, POST' })
        response.end()
        return
      }
      send(response, 404, { ok: false, error: `${method} ${route} is not served` })
    } catch (error) {
      send(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Mount the route once the profile has a webserver.
 *
 * Waits for the service instead of reading it once: a profile may mount the web
 * carrier after this plugin. Disposal unregisters the route.
 *
 * @param ctx - plugin context with the Cordis `inject` helper.
 * @param options - see {@link MountOptions}.
 */
export function mountStatusRoute(ctx: InjectingContext, options: MountOptions): void {
  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (server === undefined || typeof server.register !== 'function') return
    const unregister = server.register({
      kind: 'prefix',
      path: (options.path ?? STATUS_ROUTE_PATH).replace(/\/+$/, ''),
      handler: createStatusHandler(options),
    })
    scope.effect?.(() => () => {
      unregister()
    })
    options.log?.(`route mounted at ${options.path ?? STATUS_ROUTE_PATH}`)
  })
}
