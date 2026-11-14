import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { formatBytes } from './format'
import type { LifetimeTotals } from './stats-file'
import { formatTokens } from './tokens'

/** Re-exported so callers keep one import site for the session report. */
export { formatBytes }

/** Why one result was not compressed (for the status summary). */
export type SkipReason = 'size' | 'scope' | 'marked' | 'payload' | 'ptc'

/** What a compression pass did to one tool. */
export interface ToolSaving {
  calls: number
  inBytes: number
  outBytes: number
  savedTokens: number
}

/** One observed result, for the "what just happened" list. */
export interface RecentEvent {
  readonly at: number
  readonly tool: string
  readonly kind: 'compress' | 'skip'
  readonly reason?: SkipReason
  readonly savedTokens?: number
  /** Fraction of the original bytes that did not reach the model, 0–1. */
  readonly ratio?: number
}

/** One session's observed work, independent of rtk's own database. */
export interface SessionStats {
  compressions: number
  inBytes: number
  outBytes: number
  savedTokens: number
  compressMs: number
  /** Applied rewrites for this session (the process-wide counter is separate). */
  rewrites: number
  byTool: Map<string, ToolSaving>
  skipped: Record<SkipReason, number>
  errors: { rtk: number; timeout: number }
  lastAt: number
  recent: RecentEvent[]
}

/** Tool row of the JSON status payload. */
export interface ToolSnapshot {
  readonly name: string
  readonly calls: number
  readonly inBytes: number
  readonly outBytes: number
  readonly savedTokens: number
}

/** JSON-safe view of one session, served to the web UI. */
export interface SessionSnapshot {
  readonly key: string
  readonly compressions: number
  readonly inBytes: number
  readonly outBytes: number
  readonly savedTokens: number
  readonly ms: number
  readonly ratio: number
  /** Applied rewrites for this session. */
  readonly rewrites: number
  readonly skipped: Record<SkipReason, number>
  readonly errors: { rtk: number; timeout: number }
  readonly byTool: readonly ToolSnapshot[]
  readonly recent: readonly RecentEvent[]
  readonly updatedAt: number
}

/** The anonymous bucket (calls without an agent id) never reaches the disk. */
const ANONYMOUS = 'anonymous'

/** One session as written to the lifetime ledger (`stats.json` v2). */
export interface SessionRecord {
  compressions: number
  inBytes: number
  outBytes: number
  savedTokens: number
  compressMs: number
  rewrites: number
  skipped: Record<SkipReason, number>
  errors: { rtk: number; timeout: number }
  lastAt: number
  byTool: (ToolSaving & { name: string })[]
  recent: RecentEvent[]
}

/** Counters that live outside the compression layer. */
export interface RewriteCounters {
  readonly calls: number
  readonly fallbacks: number
  readonly learned: readonly string[]
  /** Proposals rejected because they no longer ran the original command. */
  readonly guards?: number
}

function emptyStats(): SessionStats {
  return {
    compressions: 0,
    inBytes: 0,
    outBytes: 0,
    savedTokens: 0,
    compressMs: 0,
    rewrites: 0,
    byTool: new Map(),
    skipped: { size: 0, scope: 0, marked: 0, payload: 0, ptc: 0 },
    errors: { rtk: 0, timeout: 0 },
    lastAt: 0,
    recent: [],
  }
}

/** Keep this many recent events per session. */
const RECENT_LIMIT = 20

/** Human byte size, one decimal for KB and above. */

/**
 * Session-scoped counters for what the plugin itself observed.
 *
 * They exist because rtk's own database answers a different question: it is
 * global, keyed by project, and mixes in every other agent that used the same
 * binary. These counters answer "what did this plugin do in *this* session",
 * never leave memory, and write no file anywhere.
 */
/** Coerce a persisted number to a non-negative finite value. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Restore one recent event, dropping anything malformed. */
function parseRecent(raw: unknown): RecentEvent | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (record.kind !== 'compress' && record.kind !== 'skip') return undefined
  const kind = record.kind === 'compress' ? ('compress' as const) : ('skip' as const)
  const base = { at: num(record.at), tool: typeof record.tool === 'string' ? record.tool : '', kind }
  if (kind === 'skip') {
    return typeof record.reason === 'string' ? { ...base, reason: record.reason as SkipReason } : base
  }
  const ratio = typeof record.ratio === 'number' && Number.isFinite(record.ratio) ? Math.max(0, Math.min(1, record.ratio)) : 0
  return { ...base, savedTokens: num(record.savedTokens), ratio }
}

/** Restore one persisted session; `undefined` when the record is unusable. */
function parseSessionRecord(raw: unknown): SessionStats | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const empty = emptyStats()
  const skipped = { ...empty.skipped }
  if (record.skipped !== null && typeof record.skipped === 'object') {
    const source = record.skipped as Record<string, unknown>
    for (const key of Object.keys(skipped) as SkipReason[]) skipped[key] = num(source[key])
  }
  const errors = { ...empty.errors }
  if (record.errors !== null && typeof record.errors === 'object') {
    const source = record.errors as Record<string, unknown>
    errors.rtk = num(source.rtk)
    errors.timeout = num(source.timeout)
  }
  const byTool = new Map<string, ToolSaving>()
  if (Array.isArray(record.byTool)) {
    for (const row of record.byTool) {
      if (row === null || typeof row !== 'object') continue
      const item = row as Record<string, unknown>
      if (typeof item.name !== 'string' || item.name === '') continue
      byTool.set(item.name, {
        calls: num(item.calls),
        inBytes: num(item.inBytes),
        outBytes: num(item.outBytes),
        savedTokens: num(item.savedTokens),
      })
    }
  }
  const recent = Array.isArray(record.recent)
    ? record.recent.flatMap((item): RecentEvent[] => {
        const event = parseRecent(item)
        return event === undefined ? [] : [event]
      })
    : []
  const lastAt = num(record.lastAt)
  // A record without a timestamp was never written by this plugin; drop it.
  if (lastAt === 0) return undefined
  return {
    compressions: num(record.compressions),
    inBytes: num(record.inBytes),
    outBytes: num(record.outBytes),
    savedTokens: num(record.savedTokens),
    compressMs: num(record.compressMs),
    rewrites: num(record.rewrites),
    byTool,
    skipped,
    errors,
    lastAt,
    recent: recent.slice(-RECENT_LIMIT),
  }
}

export function createStats(seed: Record<string, unknown> = {}) {
  const sessions = new Map<string, SessionStats>()
  // Restore previous sessions before the first event: the pill reads `snapshot`
  // during the first poll, which can happen before any new compression.
  for (const [key, value] of Object.entries(seed)) {
    if (key === ANONYMOUS) continue
    const restored = parseSessionRecord(value)
    if (restored !== undefined) sessions.set(key, restored)
  }
  /** Most recently recorded session; the web UI shows this one as "this session". */
  let active: string | undefined

  /** Session key for one call; calls without an agent share one bucket. */
  function keyOf(exec: Pick<ToolExecution, 'agent'>): string {
    return keyOfAgent(exec.agent)
  }

  /** Session key for an agent handle (the `/rtk status` caller). */
  function keyOfAgent(agent: unknown): string {
    const id = (agent as { id?: unknown } | undefined)?.id
    return typeof id === 'string' ? id : 'anonymous'
  }

  function bucket(key: string): SessionStats {
    let stats = sessions.get(key)
    if (stats === undefined) {
      stats = emptyStats()
      sessions.set(key, stats)
    }
    return stats
  }

  /**
   * Record one compression pass.
   *
   * @param exec - the call that ran.
   * @param inBytes - text size before compression.
   * @param outBytes - text size after compression.
   * @param savedTokens - estimated tokens saved, priced from the two texts (never
   *   derived from the byte delta: mixed Chinese and English text has no single
   *   bytes-per-token ratio).
   * @param ms - wall time of the round trip.
   */
  function recordCompress(
    exec: Pick<ToolExecution, 'agent' | 'name'>,
    inBytes: number,
    outBytes: number,
    savedTokens: number,
    ms: number,
  ): void {
    const stats = bucket(keyOf(exec))
    const tool = stats.byTool.get(exec.name) ?? { calls: 0, inBytes: 0, outBytes: 0, savedTokens: 0 }
    tool.calls += 1
    tool.inBytes += inBytes
    tool.outBytes += outBytes
    tool.savedTokens += savedTokens
    stats.byTool.set(exec.name, tool)
    stats.compressions += 1
    stats.inBytes += inBytes
    stats.outBytes += outBytes
    stats.savedTokens += savedTokens
    stats.compressMs += ms
    stats.lastAt = Date.now()
    stats.recent.push({
      at: stats.lastAt,
      tool: exec.name,
      kind: 'compress',
      savedTokens,
      ratio: inBytes === 0 ? 0 : Math.max(0, Math.min(1, 1 - outBytes / inBytes)),
    })
    if (stats.recent.length > RECENT_LIMIT) stats.recent.splice(0, stats.recent.length - RECENT_LIMIT)
    active = keyOf(exec)
  }

  /** Record one result that was deliberately not compressed. */
  function recordSkipped(exec: Pick<ToolExecution, 'agent' | 'name'>, reason: SkipReason): void {
    const stats = bucket(keyOf(exec))
    stats.skipped[reason] += 1
    stats.lastAt = Date.now()
    stats.recent.push({ at: stats.lastAt, tool: exec.name, kind: 'skip', reason })
    if (stats.recent.length > RECENT_LIMIT) stats.recent.splice(0, stats.recent.length - RECENT_LIMIT)
    active = keyOf(exec)
  }

  /** Record an rtk-side failure (never a normal command failure). */
  function recordError(exec: Pick<ToolExecution, 'agent'>, kind: 'rtk' | 'timeout'): void {
    bucket(keyOf(exec)).errors[kind] += 1
  }

  /** Record one applied rewrite for the call's session. */
  function recordRewrite(exec: Pick<ToolExecution, 'agent'>): void {
    const key = keyOf(exec)
    const stats = bucket(key)
    stats.rewrites += 1
    stats.lastAt = Date.now()
    active = key
  }

  /**
   * The sessions worth persisting, JSON-safe and without the anonymous bucket.
   * Called by the lifetime store on every flush.
   */
  function serializeSessions(): Record<string, SessionRecord> {
    const out: Record<string, SessionRecord> = {}
    for (const [key, stats] of sessions) {
      if (key === ANONYMOUS || stats.lastAt === 0) continue
      out[key] = {
        compressions: stats.compressions,
        inBytes: stats.inBytes,
        outBytes: stats.outBytes,
        savedTokens: stats.savedTokens,
        compressMs: stats.compressMs,
        rewrites: stats.rewrites,
        skipped: { ...stats.skipped },
        errors: { ...stats.errors },
        lastAt: stats.lastAt,
        byTool: [...stats.byTool].map(([name, tool]) => ({ name, ...tool })),
        recent: stats.recent.slice(-3),
      }
    }
    return out
  }

  /**
   * The summary lines `/rtk status` appends.
   *
   * @param key - session key.
   * @param counters - rewrite counters owned by the rewrite layer.
   * @param lifetime - cross-restart totals; `undefined` when persistence is off.
   */
  function formatLines(key: string, counters: RewriteCounters, lifetime?: LifetimeTotals): string[] {
    const stats = sessions.get(key)
    if (stats === undefined) return []
    const lines: string[] = []
    if (stats.compressions > 0) {
      const saved = stats.inBytes - stats.outBytes
      const pct = stats.inBytes === 0 ? 0 : Math.round((saved / stats.inBytes) * 100)
      const rewrite = counters.calls === 0 ? '' : `, ${String(counters.calls)} rewrites`
      const fallback = counters.fallbacks === 0 ? '' : `, ${String(counters.fallbacks)} fallback`
      lines.push(
        `session    : ${String(stats.compressions)} compressions ${formatBytes(stats.inBytes)} → ${formatBytes(stats.outBytes)} ` +
          `(-${String(pct)}%, ~${formatTokens(stats.savedTokens)} tok saved), ${(stats.compressMs / 1000).toFixed(1)} s${rewrite}${fallback}`,
      )
    }
    const skipped = Object.entries(stats.skipped).filter(([, count]) => count > 0)
    if (skipped.length > 0) {
      lines.push(`skipped    : ${skipped.map(([reason, count]) => `${reason} ${String(count)}`).join(', ')}`)
    }
    if (counters.learned.length > 0) {
      lines.push(`learned    : rewrite suppressed for ${counters.learned.join(', ')}`)
    }
    if ((counters.guards ?? 0) > 0) {
      lines.push(`guard      : ${String(counters.guards)} rewrite(s) rejected as unsafe (original ran)`)
    }
    if (lifetime !== undefined && lifetime.compressions > 0) {
      lines.push(
        `lifetime   : ${String(lifetime.compressions)} compressions, ~${formatTokens(lifetime.savedTokens)} tok saved since ${lifetime.updatedAt.slice(0, 10)}`,
      )
    }
    return lines
  }

  /**
   * Full detail for `/rtk stats`.
   *
   * @param key - session key.
   * @param counters - rewrite counters owned by the rewrite layer.
   * @param lifetime - cross-restart totals; `undefined` when persistence is off.
   */
  function formatReport(key: string, counters: RewriteCounters, lifetime?: LifetimeTotals): string {
    const stats = bucket(key)
    const saved = stats.inBytes - stats.outBytes
    const pct = stats.inBytes === 0 ? 0 : Math.round((saved / stats.inBytes) * 100)
    const lines = [
      `session    : ${key}`,
      `compress   : ${String(stats.compressions)} calls, ${formatBytes(stats.inBytes)} → ${formatBytes(stats.outBytes)} (-${String(pct)}%, ~${formatTokens(stats.savedTokens)} tok saved), ${(stats.compressMs / 1000).toFixed(1)} s`,
      `rewrite    : ${String(counters.calls)} calls, ${String(counters.fallbacks)} fallback${counters.learned.length === 0 ? '' : `, learned ${counters.learned.join(', ')}`}`,
      `guard      : ${String(counters.guards ?? 0)} rejected as unsafe`,
      `skipped    : ${Object.entries(stats.skipped).map(([reason, count]) => `${reason} ${String(count)}`).join(', ')}`,
      `errors     : rtk ${String(stats.errors.rtk)}, timeout ${String(stats.errors.timeout)}`,
    ]
    if (lifetime !== undefined) {
      if (lifetime.compressions > 0) {
        lines.push(
          `lifetime   : ${String(lifetime.compressions)} compressions, ${formatBytes(lifetime.inBytes)} → ${formatBytes(lifetime.outBytes)}, ~${formatTokens(lifetime.savedTokens)} tok saved (updated ${lifetime.updatedAt})`,
        )
        lines.push(
          `lifetime   : ${String(lifetime.rewrites)} rewrites, ${String(lifetime.fallbacks)} fallback, ${String(lifetime.guards)} guard rejection(s)`,
        )
      } else {
        lines.push('lifetime   : nothing recorded yet')
      }
    }
    if (stats.byTool.size > 0) {
      lines.push('by tool    :')
      const rows = [...stats.byTool.entries()].sort((a, b) => b[1].inBytes - a[1].inBytes)
      for (const [name, tool] of rows) {
        lines.push(
          `  ${name.padEnd(16)} ${String(tool.calls).padStart(3)} calls  ${formatBytes(tool.inBytes)} → ${formatBytes(tool.outBytes)}  ~${formatTokens(tool.savedTokens)} tok`,
        )
      }
    }
    return lines.join('\n')
  }

  /**
   * Machine-readable report for `/rtk stats --json`.
   *
   * @param key - session key.
   * @param counters - rewrite counters owned by the rewrite layer.
   * @param lifetime - cross-restart totals; omitted when persistence is off.
   */
  function toJson(key: string, counters: RewriteCounters, lifetime?: LifetimeTotals): string {
    const stats = bucket(key)
    return JSON.stringify(
      {
        session: key,
        compress: {
          calls: stats.compressions,
          inBytes: stats.inBytes,
          outBytes: stats.outBytes,
          savedBytes: stats.inBytes - stats.outBytes,
          savedTokens: stats.savedTokens,
          ms: Math.round(stats.compressMs),
          byTool: Object.fromEntries(stats.byTool),
        },
        rewrite: {
          calls: counters.calls,
          fallbacks: counters.fallbacks,
          learned: counters.learned,
          guards: counters.guards ?? 0,
        },
        skipped: stats.skipped,
        errors: stats.errors,
        lifetime: lifetime ?? null,
      },
      null,
      2,
    )
  }

  /** Aggregate numbers for the "did compression do anything" check. */
  function summary(key: string): { calls: number; savedBytes: number } {
    const stats = sessions.get(key)
    if (stats === undefined) return { calls: 0, savedBytes: 0 }
    return { calls: stats.compressions, savedBytes: stats.inBytes - stats.outBytes }
  }

  /** The session that recorded something most recently (for the web UI). */
  function activeKey(): string | undefined {
    return active
  }

  /**
   * JSON-safe view of one session, or `undefined` when it recorded nothing.
   *
   * @param key - session key (`stats.keyOfAgent(agent)`).
   */
  function snapshot(key: string | undefined): SessionSnapshot | undefined {
    if (key === undefined) return undefined
    const stats = sessions.get(key)
    if (stats === undefined) return undefined
    return {
      key,
      compressions: stats.compressions,
      inBytes: stats.inBytes,
      outBytes: stats.outBytes,
      savedTokens: stats.savedTokens,
      ms: Math.round(stats.compressMs),
      ratio: stats.inBytes === 0 ? 0 : Math.max(0, Math.min(1, 1 - stats.outBytes / stats.inBytes)),
      rewrites: stats.rewrites,
      skipped: { ...stats.skipped },
      errors: { ...stats.errors },
      byTool: [...stats.byTool.entries()]
        .map(([name, tool]) => ({ name, ...tool }))
        .sort((left, right) => right.inBytes - left.inBytes),
      recent: stats.recent.slice(-3),
      updatedAt: stats.lastAt,
    }
  }

  return {
    keyOf,
    keyOfAgent,
    recordCompress,
    recordSkipped,
    recordError,
    recordRewrite,
    serializeSessions,
    formatLines,
    formatReport,
    toJson,
    summary,
    activeKey,
    snapshot,
  }
}
