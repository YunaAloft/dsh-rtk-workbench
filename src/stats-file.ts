/**
 * Cross-restart totals for the plugin's own work.
 *
 * Session counters die with the process, which makes the plugin look useless
 * after a restart even when it has been compressing for weeks. This store keeps
 * **counts only** — never command text, never tool output, never a path — in one
 * small JSON file under the harness home.
 *
 * Write discipline: the file is replaced atomically (write a sibling temp file,
 * rename over the target) and at most every few seconds or every N
 * compressions, so a hot path never waits on the disk. Every failure is silent:
 * a read-only home directory must not turn tool calls into errors. Losing a few
 * counts is acceptable; blocking a tool call is not.
 *
 * @module dsh-rtk-workbench/stats-file
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

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
}

/** Ledger format version; a future incompatible shape bumps it. */
export const LIFETIME_VERSION = 1

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
 * @returns the parsed totals, or `undefined` when nothing usable is there.
 */
function readLedger(file: string): LifetimeTotals | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Missing on first run; truncated or corrupt after a crash. Both mean "start over".
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  return {
    compressions: count(record.compressions),
    inBytes: count(record.inBytes),
    outBytes: count(record.outBytes),
    savedTokens: count(record.savedTokens),
    rewrites: count(record.rewrites),
    fallbacks: count(record.fallbacks),
    guards: count(record.guards),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  }
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
  let totals: LifetimeTotals | undefined
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
    totals = readLedger(options.file) ?? emptyTotals(now())
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

  /** Persist the current totals; failures are silent by design. */
  async function flush(): Promise<void> {
    if (!options.enabled || !dirty || totals === undefined) return
    const snapshot: LifetimeTotals = { ...totals, updatedAt: new Date(now()).toISOString() }
    dirty = false
    pending = 0
    lastFlush = now()
    totals = snapshot
    chain = chain.then(async () => {
      try {
        mkdirSync(path.dirname(options.file), { recursive: true })
        const temporary = `${options.file}.${String(process.pid)}.tmp`
        await writeFile(temporary, `${JSON.stringify({ version: LIFETIME_VERSION, ...snapshot }, null, 2)}\n`, 'utf8')
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

  /** Flush and stop: called from the plugin's dispose effect. */
  async function dispose(): Promise<void> {
    await flush()
  }

  return { load, record, flush, snapshot, dispose, file: options.file }
}
