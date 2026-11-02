import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Why one result was not compressed (for the status summary). */
export type SkipReason = 'size' | 'scope' | 'marked' | 'payload'

/** What a compression pass did to one tool. */
export interface ToolSaving {
  calls: number
  inBytes: number
  outBytes: number
}

/** One session's observed work, independent of rtk's own database. */
export interface SessionStats {
  compressions: number
  inBytes: number
  outBytes: number
  compressMs: number
  byTool: Map<string, ToolSaving>
  skipped: Record<SkipReason, number>
  errors: { rtk: number; timeout: number }
}

/** Counters that live outside the compression layer. */
export interface RewriteCounters {
  readonly calls: number
  readonly fallbacks: number
  readonly learned: readonly string[]
}

function emptyStats(): SessionStats {
  return {
    compressions: 0,
    inBytes: 0,
    outBytes: 0,
    compressMs: 0,
    byTool: new Map(),
    skipped: { size: 0, scope: 0, marked: 0, payload: 0 },
    errors: { rtk: 0, timeout: 0 },
  }
}

/** Human byte size, one decimal for KB and above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Rough token estimate (bytes / 4), matching the plugin's README figures. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4)
}

/**
 * Session-scoped counters for what the plugin itself observed.
 *
 * They exist because rtk's own database answers a different question: it is
 * global, keyed by project, and mixes in every other agent that used the same
 * binary. These counters answer "what did this plugin do in *this* session",
 * never leave memory, and write no file anywhere.
 */
export function createStats() {
  const sessions = new Map<string, SessionStats>()

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

  /** Record one compression pass (or one "rtk had nothing better" outcome). */
  function recordCompress(
    exec: Pick<ToolExecution, 'agent' | 'name'>,
    inBytes: number,
    outBytes: number,
    ms: number,
  ): void {
    const stats = bucket(keyOf(exec))
    const tool = stats.byTool.get(exec.name) ?? { calls: 0, inBytes: 0, outBytes: 0 }
    tool.calls += 1
    tool.inBytes += inBytes
    tool.outBytes += outBytes
    stats.byTool.set(exec.name, tool)
    stats.compressions += 1
    stats.inBytes += inBytes
    stats.outBytes += outBytes
    stats.compressMs += ms
  }

  /** Record one result that was deliberately not compressed. */
  function recordSkipped(exec: Pick<ToolExecution, 'agent'>, reason: SkipReason): void {
    bucket(keyOf(exec)).skipped[reason] += 1
  }

  /** Record an rtk-side failure (never a normal command failure). */
  function recordError(exec: Pick<ToolExecution, 'agent'>, kind: 'rtk' | 'timeout'): void {
    bucket(keyOf(exec)).errors[kind] += 1
  }

  /** The summary lines `/rtk status` appends. */
  function formatLines(key: string, counters: RewriteCounters): string[] {
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
          `(-${String(pct)}%, ~${String(estimateTokens(saved))} tok), ${(stats.compressMs / 1000).toFixed(1)} s${rewrite}${fallback}`,
      )
    }
    const skipped = Object.entries(stats.skipped).filter(([, count]) => count > 0)
    if (skipped.length > 0) {
      lines.push(`skipped    : ${skipped.map(([reason, count]) => `${reason} ${String(count)}`).join(', ')}`)
    }
    if (counters.learned.length > 0) {
      lines.push(`learned    : rewrite suppressed for ${counters.learned.join(', ')}`)
    }
    return lines
  }

  /** Full detail for `/rtk stats`. */
  function formatReport(key: string, counters: RewriteCounters): string {
    const stats = bucket(key)
    const saved = stats.inBytes - stats.outBytes
    const pct = stats.inBytes === 0 ? 0 : Math.round((saved / stats.inBytes) * 100)
    const lines = [
      `session    : ${key}`,
      `compress   : ${String(stats.compressions)} calls, ${formatBytes(stats.inBytes)} → ${formatBytes(stats.outBytes)} (-${String(pct)}%, ~${String(estimateTokens(saved))} tok), ${(stats.compressMs / 1000).toFixed(1)} s`,
      `rewrite    : ${String(counters.calls)} calls, ${String(counters.fallbacks)} fallback${counters.learned.length === 0 ? '' : `, learned ${counters.learned.join(', ')}`}`,
      `skipped    : ${Object.entries(stats.skipped).map(([reason, count]) => `${reason} ${String(count)}`).join(', ')}`,
      `errors     : rtk ${String(stats.errors.rtk)}, timeout ${String(stats.errors.timeout)}`,
    ]
    if (stats.byTool.size > 0) {
      lines.push('by tool    :')
      const rows = [...stats.byTool.entries()].sort((a, b) => b[1].inBytes - a[1].inBytes)
      for (const [name, tool] of rows) {
        lines.push(
          `  ${name.padEnd(16)} ${String(tool.calls).padStart(3)} calls  ${formatBytes(tool.inBytes)} → ${formatBytes(tool.outBytes)}`,
        )
      }
    }
    return lines.join('\n')
  }

  /** Machine-readable report for `/rtk stats --json`. */
  function toJson(key: string, counters: RewriteCounters): string {
    const stats = bucket(key)
    return JSON.stringify(
      {
        session: key,
        compress: {
          calls: stats.compressions,
          inBytes: stats.inBytes,
          outBytes: stats.outBytes,
          savedBytes: stats.inBytes - stats.outBytes,
          ms: Math.round(stats.compressMs),
          byTool: Object.fromEntries(stats.byTool),
        },
        rewrite: { calls: counters.calls, fallbacks: counters.fallbacks, learned: counters.learned },
        skipped: stats.skipped,
        errors: stats.errors,
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

  return {
    keyOf,
    keyOfAgent,
    recordCompress,
    recordSkipped,
    recordError,
    formatLines,
    formatReport,
    toJson,
    summary,
  }
}
