import { describe, expect, it } from 'vitest'
import { createStats, formatBytes } from '../src/stats'
import type { LifetimeTotals } from '../src/stats-file'

/** A call as the stats store sees it. */
function call(id: string, name = 'bash') {
  return { name, agent: { id } } as never
}

/** A ledger row as the status command renders it. */
function lifetime(overrides: Partial<LifetimeTotals> = {}): LifetimeTotals {
  return {
    compressions: 42,
    inBytes: 100_000,
    outBytes: 10_000,
    savedTokens: 12_345,
    rewrites: 7,
    fallbacks: 1,
    guards: 2,
    updatedAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  }
}

describe('formatBytes', () => {
  it('uses B, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})

describe('session stats', () => {
  it('summarises compressions, savings, skips and learned verbs', () => {
    const stats = createStats()
    stats.recordCompress(call('s1'), 10_000, 2_000, 3_200, 500)
    stats.recordCompress(call('s1'), 4_000, 4_000, 0, 100)
    stats.recordSkipped(call('s1'), 'size')
    stats.recordSkipped(call('s1'), 'ptc')
    const lines = stats.formatLines('s1', { calls: 2, fallbacks: 1, learned: ['ls'], guards: 3 })
    expect(lines[0]).toContain('2 compressions')
    expect(lines[0]).toContain('-57%')
    expect(lines[0]).toContain('3.2k tok saved')
    expect(lines[0]).toContain('2 rewrites')
    expect(lines[0]).toContain('1 fallback')
    expect(lines.join('\n')).toContain('skipped    : size 1, ptc 1')
    expect(lines.join('\n')).toContain('learned    : rewrite suppressed for ls')
    expect(lines.join('\n')).toContain('guard      : 3 rewrite(s) rejected')
    expect(lines.join('\n')).not.toContain('lifetime')
  })

  it('reports cross-restart totals when the ledger has them', () => {
    const stats = createStats()
    stats.recordCompress(call('s1'), 100, 50, 30, 1)
    const lines = stats.formatLines('s1', { calls: 0, fallbacks: 0, learned: [] }, lifetime())
    expect(lines.join('\n')).toContain('lifetime   : 42 compressions')
    expect(lines.join('\n')).toContain('12.3k tok saved')
    expect(lines.join('\n')).toContain('2026-11-05')
  })

  it('keeps sessions separate and empty ones silent', () => {
    const stats = createStats()
    stats.recordCompress(call('s1'), 100, 50, 25, 10)
    expect(stats.formatLines('s2', { calls: 0, fallbacks: 0, learned: [] })).toEqual([])
    expect(stats.formatLines('s1', { calls: 0, fallbacks: 0, learned: [] })[0]).toContain('1 compressions')
  })

  it('groups by tool in the full report', () => {
    const stats = createStats()
    stats.recordCompress(call('s1', 'bash'), 3000, 1000, 900, 20)
    stats.recordCompress(call('s1', 'read'), 2000, 1900, 120, 20)
    const report = stats.formatReport('s1', { calls: 0, fallbacks: 0, learned: [] })
    expect(report).toContain('by tool')
    expect(report).toContain('bash')
    expect(report).toContain('read')
    expect(report).toContain('tok')
  })

  it('renders a lifetime block from the ledger', () => {
    const stats = createStats()
    const report = stats.formatReport('s1', { calls: 0, fallbacks: 0, learned: [] }, lifetime())
    expect(report).toContain('42 compressions')
    expect(report).toContain('7 rewrites, 1 fallback, 2 guard rejection(s)')
  })

  it('serialises a machine-readable report', () => {
    const stats = createStats()
    stats.recordCompress(call('s1'), 1000, 400, 150, 5)
    stats.recordError(call('s1'), 'rtk')
    const parsed = JSON.parse(
      stats.toJson('s1', { calls: 3, fallbacks: 0, learned: [], guards: 2 }, lifetime()),
    ) as {
      compress: { calls: number; savedBytes: number; savedTokens: number }
      rewrite: { calls: number; guards: number }
      errors: { rtk: number }
      lifetime: { savedTokens: number } | null
    }
    expect(parsed.compress.calls).toBe(1)
    expect(parsed.compress.savedBytes).toBe(600)
    expect(parsed.compress.savedTokens).toBe(150)
    expect(parsed.rewrite.calls).toBe(3)
    expect(parsed.rewrite.guards).toBe(2)
    expect(parsed.errors.rtk).toBe(1)
    expect(parsed.lifetime?.savedTokens).toBe(12_345)
  })

  it('serialises null when lifetime persistence is off', () => {
    const stats = createStats()
    const parsed = JSON.parse(stats.toJson('s1', { calls: 0, fallbacks: 0, learned: [] })) as {
      lifetime: unknown
    }
    expect(parsed.lifetime).toBeNull()
  })
})

describe('session persistence', () => {
  it('counts applied rewrites per session', () => {
    const stats = createStats()
    stats.recordCompress(call('s1'), 1000, 200, 300, 40)
    stats.recordRewrite(call('s1'))
    stats.recordRewrite(call('s1'))
    stats.recordRewrite(call('s2'))
    expect(stats.snapshot('s1')?.rewrites).toBe(2)
    expect(stats.snapshot('s2')?.rewrites).toBe(1)
  })

  it('round-trips the persisted session map and skips the anonymous bucket', () => {
    const first = createStats()
    first.recordCompress(call('s1'), 1000, 200, 300, 40)
    first.recordRewrite(call('s1'))
    first.recordSkipped(call('s1'), 'size')
    first.recordCompress({ name: 'bash', agent: undefined } as never, 10, 5, 1, 1)
    const saved = first.serializeSessions()
    expect(Object.keys(saved)).toEqual(['s1'])
    const second = createStats(saved)
    const view = second.snapshot('s1')
    expect(view?.compressions).toBe(1)
    expect(view?.savedTokens).toBe(300)
    expect(view?.rewrites).toBe(1)
    expect(view?.skipped.size).toBe(1)
    expect(view?.byTool[0]).toMatchObject({ name: 'bash', calls: 1 })
    expect(second.snapshot('anonymous')).toBeUndefined()
  })

  it('ignores malformed seed records', () => {
    const stats = createStats({ broken: 'nope', stamp: { lastAt: 'never' } })
    expect(stats.snapshot('broken')).toBeUndefined()
    expect(stats.snapshot('stamp')).toBeUndefined()
  })
})
