import { describe, expect, it } from 'vitest'
import { estimateTokens as hostEstimate } from '../src/tokens'

/**
 * The benchmark script is plain JavaScript (it runs without a build step), so it
 * carries a copy of the token formula. This test is what keeps the copy honest.
 */
describe('benchmark token formula', () => {
  it('agrees with src/tokens.ts on every interesting shape', async () => {
    const module = (await import(new URL('../scripts/tokens.mjs', import.meta.url).href)) as {
      estimateTokens: (text: string) => number
    }
    const samples = [
      '',
      'a',
      'a'.repeat(4000),
      '汉'.repeat(500),
      `${'a'.repeat(2000)}${'汉'.repeat(250)}`,
      '，。！？',
      'アイウエオ',
      '😀',
      'log line\n'.repeat(500),
    ]
    for (const sample of samples) {
      expect(module.estimateTokens(sample), JSON.stringify(sample.slice(0, 12))).toBe(hostEstimate(sample))
    }
  })
})
