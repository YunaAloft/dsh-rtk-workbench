import { describe, expect, it } from 'vitest'
import { estimateSavedTokens, estimateTokens, formatTokens } from '../src/tokens'

/**
 * The formula is a documented heuristic, not a tokenizer: these samples are
 * constructed so the expected number can be computed by hand from the two
 * constants (0.25 tokens per narrow character, 0.6 per CJK character). Pinning
 * them exactly is what keeps `/rtk stats`, the UI and the README from drifting
 * apart; accuracy against a provider tokenizer cannot be measured offline.
 */
describe('estimateTokens', () => {
  it('prices ASCII-dense text at four characters per token', () => {
    expect(estimateTokens('a'.repeat(4000))).toBe(1000)
    expect(estimateTokens('log line\n'.repeat(500))).toBe(1125)
  })

  it('prices CJK text at 0.6 tokens per character', () => {
    expect(estimateTokens('汉'.repeat(500))).toBe(300)
  })

  it('prices mixed text without pretending one byte ratio fits both', () => {
    expect(estimateTokens(`${'a'.repeat(2000)}${'汉'.repeat(250)}`)).toBe(650)
  })

  it('counts full-width punctuation, kana and emoji the documented way', () => {
    expect(estimateTokens('，。！？')).toBe(3)
    expect(estimateTokens('アイウエオ')).toBe(3)
    // A surrogate pair is two UTF-16 code units, both priced as narrow.
    expect(estimateTokens('😀')).toBe(1)
  })

  it('rounds up so a non-empty text never prices at zero', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('estimateSavedTokens', () => {
  it('prices both sides instead of the byte delta', () => {
    expect(estimateSavedTokens('x'.repeat(4000), 'x'.repeat(400))).toBe(900)
  })

  it('accounts for a Chinese payload that keeps its byte count high', () => {
    // 100 Chinese characters (300 bytes) -> 10 characters: 60 - 6 tokens.
    expect(estimateSavedTokens('汉'.repeat(100), '汉'.repeat(10))).toBe(54)
  })

  it('never reports a negative saving', () => {
    expect(estimateSavedTokens('short', 'a much longer replacement body')).toBe(0)
  })

  it('reports zero when nothing changed', () => {
    expect(estimateSavedTokens('same', 'same')).toBe(0)
  })
})

describe('formatTokens', () => {
  it('uses plain numbers, k and M', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12.4k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })
})
