import { describe, expect, it } from 'vitest'
import { panelSections, pillText, pillVisible, readStatus, toneOf, type Translate } from '../src/client/model'
import { dictionaries } from '../src/client/dict'

/** A translator over the real dictionaries, so tests see what users read. */
function translate(language: 'zh' | 'en'): Translate {
  const table = dictionaries[language] as Record<string, string>
  return (key, params) => {
    const template = table[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}

/** One document shaped like `GET /status`. */
function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    updatedAt: '2026-11-05T00:00:00.000Z',
    binary: { source: 'bundled', version: 'rtk 1.1.0' },
    probe: { state: 'ok', detail: 'rtk 1.1.0 (probe 120 ms)' },
    pipeline: { mode: 'plugin-owned', health: 'ok' },
    switches: { rewrite: true, compress: true, awareness: true, guard: 'enforce', deny: false, ui: true },
    rewrites: { calls: 3, fallbacks: 0, guards: 1, learned: [] },
    session: {
      key: 's1',
      compressions: 12,
      inBytes: 100_000,
      outBytes: 19_000,
      savedTokens: 12_400,
      ms: 1400,
      ratio: 0.81,
      skipped: { size: 9, scope: 4, marked: 0, payload: 0, ptc: 3 },
      errors: { rtk: 0, timeout: 0 },
      byTool: [{ name: 'bash', calls: 12, inBytes: 100_000, outBytes: 19_000, savedTokens: 12_400 }],
      recent: [{ at: 1_760_000_000_000, tool: 'bash', kind: 'compress', savedTokens: 900, ratio: 0.9 }],
      updatedAt: 1_760_000_000_000,
    },
    lifetime: {
      compressions: 42,
      inBytes: 1_000_000,
      outBytes: 100_000,
      savedTokens: 220_000,
      rewrites: 7,
      fallbacks: 1,
      guards: 2,
      updatedAt: '2026-11-05T00:00:00.000Z',
    },
    patched: ['bash', 'pwsh'],
    persist: { enabled: true },
    ...overrides,
  }
}

describe('readStatus', () => {
  it('normalizes a full document', () => {
    const view = readStatus(payload())
    expect(view?.binary.source).toBe('bundled')
    expect(view?.session?.savedTokens).toBe(12_400)
    expect(view?.session?.byTool[0]?.name).toBe('bash')
    expect(view?.lifetime?.compressions).toBe(42)
  })

  it('rejects a document that is not ours', () => {
    expect(readStatus({ ok: false })).toBeUndefined()
    expect(readStatus(null)).toBeUndefined()
    expect(readStatus('nope')).toBeUndefined()
  })

  it('tolerates a missing session and missing lifetime', () => {
    const view = readStatus(payload({ session: null, lifetime: null }))
    expect(view?.session).toBeNull()
    expect(view?.lifetime).toBeNull()
  })
})

describe('toneOf', () => {
  it('is off before the first document', () => {
    expect(toneOf(undefined, undefined)).toBe('off')
  })

  it('warns when the fetch fails', () => {
    expect(toneOf(readStatus(payload()), 'HTTP 500')).toBe('warn')
  })

  it('warns on a failed probe and on a fallback pipeline', () => {
    expect(toneOf(readStatus(payload({ probe: { state: 'fail', detail: 'enoent' } })), undefined)).toBe('warn')
    expect(toneOf(readStatus(payload({ pipeline: { mode: 'plugin-owned', health: 'problems' } })), undefined)).toBe('warn')
  })

  it('is ok for a healthy document and off when compression is disabled', () => {
    expect(toneOf(readStatus(payload()), undefined)).toBe('ok')
    const disabled = readStatus(
      payload({ switches: { rewrite: true, compress: false, awareness: true, guard: 'enforce', deny: false, ui: true } }),
    )
    expect(toneOf(disabled, undefined)).toBe('off')
  })
})

describe('pillVisible', () => {
  it('stays hidden until a document arrives, and when the UI switch is off', () => {
    expect(pillVisible(undefined)).toBe(false)
    expect(pillVisible(readStatus(payload()))).toBe(true)
    const hidden = readStatus(
      payload({ switches: { rewrite: true, compress: true, awareness: true, guard: 'enforce', deny: false, ui: false } }),
    )
    expect(pillVisible(hidden)).toBe(false)
  })
})

describe('pillText', () => {
  it('names the unit, because a bare number reads like usage', () => {
    const text = pillText(readStatus(payload()), undefined, translate('zh'))
    expect(text.primary).toBe('省 12.4k token · -81%')
    expect(text.secondary).toContain('12 次压缩')
  })

  it('says ready before anything was compressed', () => {
    const view = readStatus(payload({ session: null }))
    expect(pillText(view, undefined, translate('en')).primary).toBe('rtk ready')
  })

  it('explains a degraded state instead of showing numbers', () => {
    const view = readStatus(payload({ pipeline: { mode: 'plugin-owned', health: 'problems', detail: 'validate failed' } }))
    const text = pillText(view, undefined, translate('en'))
    expect(text.primary).toBe('rtk degraded')
    expect(text.secondary).toBe('validate failed')
  })

  it('reports a failed probe', () => {
    const view = readStatus(payload({ probe: { state: 'fail', detail: 'enoent' } }))
    expect(pillText(view, undefined, translate('en')).primary).toBe('rtk unusable')
  })
})

describe('panelSections', () => {
  it('renders health, session, lifetime, tools and recent events', () => {
    const sections = panelSections(readStatus(payload()), undefined, translate('zh'))
    const titles = sections.map((section) => section.title)
    expect(titles).toEqual(['健康', '本会话', '累计（跨重启）', '按工具', '最近事件'])
    const session = sections[1]
    expect(session?.rows[0]?.value).toBe('≈12.4k token')
    expect(session?.note).toContain('size 9')
    expect(sections[3]?.rows[0]?.label).toBe('bash')
  })

  it('keeps the last good numbers visible when a poll fails', () => {
    const sections = panelSections(readStatus(payload()), 'HTTP 502', translate('en'))
    const health = sections[0]
    expect(health?.rows.some((row) => row.label === 'error' && row.tone === 'warn')).toBe(true)
    expect(sections[1]?.rows[0]?.value).toContain('12.4k')
  })

  it('says persistence is off instead of pretending history exists', () => {
    const sections = panelSections(readStatus(payload({ lifetime: null, persist: { enabled: false } })), undefined, translate('en'))
    expect(sections[2]?.rows[0]?.label).toContain('persistence is off')
  })

  it('shows the empty state before the first compression', () => {
    const sections = panelSections(readStatus(payload({ session: null })), undefined, translate('en'))
    expect(sections[1]?.rows[0]?.label).toBe('nothing yet')
  })
})
