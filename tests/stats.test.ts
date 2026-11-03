import { describe, expect, it } from 'vitest'
import { createStats, formatBytes } from '../src/stats'

/** A call as the stats store sees it. */
function call(id: string, name = 'bash') {
  return { name, agent: { id } } as never
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
    stats.recordCompress(call('s1'), 10_000, 2_000, 500)
    stats.recordCompress(call('s1'), 4_000, 4_000, 100)
    stats.recordSkipped(call('s1'), 'size')
    const lines = stats.formatLines('s1', { calls: 2, fallbacks: 1, learned: ['ls'], guards: 3 })
    expect(lines[0]).toContain('2 compressions')
    expect(lines[0]).toContain('-57%')
    expect(lines[0]).toContain('2 rewrites')
    expect(lines[0]).toContain('1 fallback')
    expect(lines.join('\n')).toContain('skipped    : size 1')
    expect(lines.join('\n')).toContain('learned    : rewrite suppressed for ls')
    expect(lines.join('\n')).toContain('guard      : 3 rewrite(s) rejected')
  })

  it('keeps sessions separate and empty ones silent', () => {
    const stats = createStats()
    stats.recordCompress(call('s1'), 100, 50, 10)
    expect(stats.formatLines('s2', { calls: 0, fallbacks: 0, learned: [] })).toEqual([])
    expect(stats.formatLines('s1', { calls: 0, fallbacks: 0, learned: [] })[0]).toContain('1 compressions')
  })

  it('groups by tool in the full report', () => {
    const stats = createStats()
    stats.recordCompress(call('s1', 'bash'), 3000, 1000, 20)
    stats.recordCompress(call('s1', 'read'), 2000, 1900, 20)
    const report = stats.formatReport('s1', { calls: 0, fallbacks: 0, learned: [] })
    expect(report).toContain('by tool')
    expect(report).toContain('bash')
    expect(report).toContain('read')
  })

  it('serialises a machine-readable report', () => {
    const stats = createStats()
    stats.recordCompress(call('s1'), 1000, 400, 5)
    stats.recordError(call('s1'), 'rtk')
    const parsed = JSON.parse(stats.toJson('s1', { calls: 3, fallbacks: 0, learned: [], guards: 2 })) as {
      compress: { calls: number; savedBytes: number }
      rewrite: { calls: number; guards: number }
      errors: { rtk: number }
    }
    expect(parsed.compress.calls).toBe(1)
    expect(parsed.compress.savedBytes).toBe(600)
    expect(parsed.rewrite.calls).toBe(3)
    expect(parsed.rewrite.guards).toBe(2)
    expect(parsed.errors.rtk).toBe(1)
  })
})
