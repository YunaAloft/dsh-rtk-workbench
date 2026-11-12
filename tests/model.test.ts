import { describe, expect, it } from 'vitest'
import { panelSections, pillText, pillVisible, readStatus, reduction, sessionMatches, toneOf, type Translate } from '../src/client/model'
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

  it('keeps the session key so the client can spot a stale snapshot', () => {
    expect(readStatus(payload())?.session?.key).toBe('s1')
  })
})

describe('sessionMatches', () => {
  it('flags a snapshot from another session as stale', () => {
    const view = readStatus(payload())
    expect(sessionMatches(view!, 's1')).toBe(true)
    expect(sessionMatches(view!, 's2')).toBe(false)
  })

  it('treats an empty session and an unknown current key as not stale', () => {
    expect(sessionMatches(readStatus(payload({ session: null }))!, 's2')).toBe(true)
    expect(sessionMatches(readStatus(payload())!, undefined)).toBe(true)
    expect(sessionMatches(readStatus(payload())!, '')).toBe(true)
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
    expect(text.primary).toBe('省 12.4k token · ↓81%')
    expect(text.secondary).toContain('12 次压缩')
  })

  it('states the direction with an arrow instead of a minus sign', () => {
    // A leading minus reads as a loss next to "saved … token", and the ASCII
    // hyphen does not match the typographic minus the docs use.
    const text = pillText(readStatus(payload()), undefined, translate('en'))
    expect(text.primary).not.toContain('-')
    expect(text.primary).toContain('↓81%')
    expect(reduction(0.3949)).toBe('↓39%')
    expect(reduction(-1)).toBe('↓0%')
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

  it('shows loading instead of the previous session numbers after a switch', () => {
    const view = readStatus(payload())
    expect(pillText(view, undefined, translate('zh'), 's1').primary).toBe('省 12.4k token · ↓81%')
    expect(pillText(view, undefined, translate('zh'), 's2').primary).toBe('rtk 读取中')
    expect(pillText(view, undefined, translate('zh'), 's2').primary).not.toContain('12.4k')
  })
})

describe('panelSections', () => {
  it('renders health, session, lifetime, tools and recent events', () => {
    const sections = panelSections(readStatus(payload()), undefined, translate('zh'))
    const titles = sections.map((section) => section.title)
    expect(titles).toEqual(['健康', '本会话', '累计（跨重启）', '按工具', '最近事件'])
    const session = sections[1]
    expect(session?.rows[0]?.value).toBe('≈12.4k token')
    expect(session?.rows[1]?.value).toContain('降幅 81%')
    expect(session?.rows[1]?.value).not.toContain('-81')
    expect(session?.note).toContain('size 9')
    expect(sections[3]?.rows[0]?.label).toBe('bash')
    expect(sections[4]?.rows[0]?.value).toContain('↓90%')
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

  it('masks the stale session and explains the mismatch in the health rows', () => {
    const stale = {
      session: {
        key: 'session-alpha-long-id',
        compressions: 2,
        inBytes: 1000,
        outBytes: 200,
        savedTokens: 300,
        ms: 100,
        ratio: 0.8,
        skipped: {},
        errors: {},
        byTool: [],
        recent: [],
        updatedAt: 1_760_000_000_000,
      },
    }
    const sections = panelSections(readStatus(payload(stale)), undefined, translate('zh'), 'session-beta-long-id')
    expect(sections).toHaveLength(2)
    expect(sections[1]?.rows[0]?.label).toBe('切换会话后正在读取…')
    const keysRow = sections[0]?.rows.find((row) => row.label === '快照会话')
    expect(keysRow?.tone).toBe('warn')
    expect(keysRow?.value).toContain('≠')
    // Long ids are shortened so the row stays readable in a bug report screenshot.
    expect(keysRow?.value).toContain('sessio…g-id')
    expect(keysRow?.value).not.toContain('session-alpha-long-id')
    expect(keysRow?.value).not.toContain('session-beta-long-id')
  })

  it('confirms the snapshot belongs to the current session', () => {
    const sections = panelSections(readStatus(payload()), undefined, translate('zh'), 's1')
    const keysRow = sections[0]?.rows.find((row) => row.label === '快照会话')
    expect(keysRow?.value).toBe('与当前会话一致')
    expect(sections.map((section) => section.title)).toContain('本会话')
  })
})
