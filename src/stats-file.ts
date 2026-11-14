/**
 * Cross-restart counters for the plugin's own work.
 *
 * Two layers share one document: lifetime totals, and a bounded map of
 * per-session counters so the pill still shows this conversation's savings
 * after a restart. Only **counts, tool names and timestamps** are written —
 * never command text, never tool output, never a path.
 *
 * Write discipline: the file is replaced atomically (write a sibling temp file,
 * rename over the target) and at most every few seconds or every N events, so a
 * hot path never waits on the disk. Every failure is silent: a read-only home
 * directory must not turn tool calls into errors. Losing a few counts is
 * acceptable; blocking a tool call is not.
 *
 * @module dsh-rtk-workbench/stats-file
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { SessionRecord } from './stats'

/** Shape of one written ledger. */
export interface LifetimeTotals {
  compressions: number
  inBytes: number
  outBytes: number
  savedTokens: number
  rewrites: number
  fallbacks: number
  guards: number
  /** ISO timestamp of the last successful flush. */
  updatedAt: string
}

/** One observed event that the lifetime ledger counts. */
export type LifetimeEvent =
  | {
      readonly kind: 'compress'
      readonly inBytes: number
      readonly outBytes: number
      readonly savedTokens: number
    }
  | { readonly kind: 'rewrite' }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'guard' }

/** Constructor options; tests inject a temp path and a fake clock. */
export interface LifetimeStoreOptions {
  /** `false` keeps everything in memory (nothing is read or written). */
  readonly enabled: boolean
  /** Absolute path of the ledger file. */
  readonly file: string
  /** Minimum gap between flushes. */
  readonly flushIntervalMs?: number
  /** Flush after this many recorded events at the latest. */
  readonly flushEvery?: number
  readonly now?: () => number
  /** Session records to persist, read on every flush. */
  readonly sessions?: () => Record<string, SessionRecord>
  /** Most sessions kept; defaults to {@link SESSION_LIMIT}. */
  readonly sessionLimit?: number
  /** Sessions older than this are dropped; defaults to {@link SESSION_MAX_AGE_MS}. */
  readonly sessionMaxAgeMs?: number
}

/** Ledger format version; a future incompatible shape bumps it. */
export const LIFETIME_VERSION = 2

/** Most sessions kept in the ledger; the oldest by `lastAt` are dropped. */
export const SESSION_LIMIT = 512

/** Sessions older than this are dropped on load and on write. */
export const SESSION_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

/** `<DSH_HOME>/rtk-workbench/stats.json`, matching the pipeline directory. */
export function defaultStatsFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(home, 'rtk-workbench', 'stats.json')
}

function emptyTotals(now: number): LifetimeTotals {
  return {
    compressions: 0,
    inBytes: 0,
    outBytes: 0,
    savedTokens: 0,
    rewrites: 0,
    fallbacks: 0,
    guards: 0,
    updatedAt: new Date(now).toISOString(),
  }
}

/** Coerce one field to a non-negative finite number. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Read one ledger, tolerating a truncated or hand-edited file.
 *
 * @param file - absolute ledger path.
 * @returns the parsed totals and raw session map, or `undefined` when nothing usable is there.
 */
function readLedger(file: string): { totals: LifetimeTotals; sessions: Record<string, unknown> } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Missing on first run; truncated or corrupt after a crash. Both mean "start over".
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const sessions = record.sessions !== null && typeof record.sessions === 'object' && !Array.isArray(record.sessions)
    ? record.sessions as Record<string, unknown>
    : {}
  return {
    totals: {
      compressions: count(record.compressions),
      inBytes: count(record.inBytes),
      outBytes: count(record.outBytes),
      savedTokens: count(record.savedTokens),
      rewrites: count(record.rewrites),
      fallbacks: count(record.fallbacks),
      guards: count(record.guards),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    },
    sessions,
  }
}

/** Keep the newest sessions within the age and count limits. */
function pruneSessions(
  sessions: Record<string, unknown>,
  now: number,
  limit: number,
  maxAgeMs: number,
): Record<string, SessionRecord> {
  const kept: [string, SessionRecord][] = []
  for (const [key, value] of Object.entries(sessions)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Partial<SessionRecord>
    const lastAt = typeof record.lastAt === 'number' && Number.isFinite(record.lastAt) ? record.lastAt : 0
    if (lastAt === 0 || now - lastAt > maxAgeMs) continue
    kept.push([key, record as SessionRecord])
  }
  kept.sort((left, right) => right[1].lastAt - left[1].lastAt)
  return Object.fromEntries(kept.slice(0, limit))
}

/**
 * Build the lifetime ledger for one plugin instance.
 *
 * @param options - enable switch, file path and flush policy.
 */
export function createLifetimeStore(options: LifetimeStoreOptions) {
  const now = options.now ?? (() => Date.now())
  const flushIntervalMs = options.flushIntervalMs ?? 5_000
  const flushEvery = options.flushEvery ?? 25
  const sessionLimit = options.sessionLimit ?? SESSION_LIMIT
  const sessionMaxAgeMs = options.sessionMaxAgeMs ?? SESSION_MAX_AGE_MS
  let totals: LifetimeTotals | undefined
  let sessions: Record<string, SessionRecord> = {}
  let dirty = false
  let pending = 0
  let lastFlush = 0
  /** Serialises writes so two flushes never interleave their renames. */
  let chain: Promise<void> = Promise.resolve()

  /**
   * Load the previous ledger once, synchronously.
   *
   * Synchronous on purpose: `apply()` cannot await, and a later load would
   * overwrite the counts recorded in the meantime. The file is a few hundred
   * bytes.
   */
  function load(): void {
    if (!options.enabled || totals !== undefined) return
    const loaded = readLedger(options.file)
    totals = loaded?.totals ?? emptyTotals(now())
    sessions = pruneSessions(loaded?.sessions ?? {}, now(), sessionLimit, sessionMaxAgeMs)
    lastFlush = now()
  }

  /** Record one event; schedules a flush when the policy says so. */
  function record(event: LifetimeEvent): void {
    if (!options.enabled) return
    load()
    const ledger = totals ?? emptyTotals(now())
    totals = ledger
    switch (event.kind) {
      case 'compress':
        ledger.compressions += 1
        ledger.inBytes += event.inBytes
        ledger.outBytes += event.outBytes
        ledger.savedTokens += event.savedTokens
        break
      case 'rewrite':
        ledger.rewrites += 1
        break
      case 'fallback':
        ledger.fallbacks += 1
        break
      case 'guard':
        ledger.guards += 1
        break
    }
    dirty = true
    pending += 1
    if (pending >= flushEvery || now() - lastFlush >= flushIntervalMs) void flush()
  }

  /** Persist the current totals and session map; failures are silent by design. */
  async function flush(): Promise<void> {
    if (!options.enabled || !dirty || totals === undefined) return
    const snapshot: LifetimeTotals = { ...totals, updatedAt: new Date(now()).toISOString() }
    // Pull the sessions at flush time so the hot path never serialises them.
    if (options.sessions !== undefined) sessions = pruneSessions(options.sessions(), now(), sessionLimit, sessionMaxAgeMs)
    dirty = false
    pending = 0
    lastFlush = now()
    totals = snapshot
    chain = chain.then(async () => {
      try {
        mkdirSync(path.dirname(options.file), { recursive: true })
        const temporary = `${options.file}.${String(process.pid)}.tmp`
        const document = { version: LIFETIME_VERSION, ...snapshot, sessions }
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        await rename(temporary, options.file)
      } catch {
        // A read-only home or a locked file: keep the in-memory totals, retry on
        // the next flush. Counters are nice to have, tool calls are not.
      }
    })
    await chain
  }

  /** The totals to display, or `undefined` when persistence is off. */
  function snapshot(): LifetimeTotals | undefined {
    if (!options.enabled) return undefined
    load()
    return totals === undefined ? undefined : { ...totals }
  }

  /** The persisted sessions (already pruned), or `{}` when persistence is off. */
  function sessionsSnapshot(): Record<string, SessionRecord> {
    if (!options.enabled) return {}
    load()
    return pruneSessions(sessions, now(), sessionLimit, sessionMaxAgeMs)
  }

  /** Flush and stop: called from the plugin's dispose effect. */
  async function dispose(): Promise<void> {
    await flush()
  }

  return { load, record, flush, snapshot, sessionsSnapshot, dispose, file: options.file }
}
