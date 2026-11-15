import { afterEach, describe, expect, it, vi } from 'vitest'

interface StyleStub {
  id: string
  tagName: string
  textContent: string
}

/**
 * A document small enough for the stylesheet test: `injectStyles` only needs
 * `getElementById`, `createElement`, `head.appendChild` and the language used by
 * the built-in translator. jsdom is not a dependency of this repository.
 */
function documentStub(existing: StyleStub | null) {
  const appended: StyleStub[] = []
  return {
    baseURI: 'http://localhost/',
    documentElement: { lang: 'en' },
    getElementById: (id: string): StyleStub | null => (existing?.id === id ? existing : null),
    createElement: (tag: string): StyleStub => ({ id: '', tagName: tag.toUpperCase(), textContent: '' }),
    head: {
      appendChild: (style: StyleStub): void => {
        appended.push(style)
      },
    },
    appended,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('injectStyles', () => {
  it('creates the stylesheet when the page has none', async () => {
    const document = documentStub(null)
    vi.stubGlobal('document', document)
    vi.resetModules()
    const { injectStyles } = await import('../src/client/styles')
    injectStyles()
    expect(document.appended).toHaveLength(1)
    expect(document.appended[0]?.id).toBe('rtk-workbench-styles')
    expect(document.appended[0]?.textContent).toContain('.rtkw-pill')
  })

  it('replaces the contents of a stylesheet left by an earlier bundle', async () => {
    const existing: StyleStub = { id: 'rtk-workbench-styles', tagName: 'STYLE', textContent: 'old CSS' }
    const document = documentStub(existing)
    vi.stubGlobal('document', document)
    vi.resetModules()
    const { injectStyles } = await import('../src/client/styles')
    injectStyles()
    // The point of issue #17: new JS + old CSS produced a 300x150 black icon.
    expect(existing.textContent).not.toBe('old CSS')
    expect(existing.textContent).toContain('.rtkw-icon')
    expect(document.appended).toHaveLength(0)
  })
})
