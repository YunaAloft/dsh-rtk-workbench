/**
 * Token estimation shared by every surface that reports savings.
 *
 * The plugin never sees the provider's tokenizer, and DSH's own meter prices
 * text with a fixed `characters / 4` heuristic (`@deepseek-ai/dsh-token-meter`),
 * so "exact tokens" is not available to anyone here. What matters instead is
 * that one formula feeds `/rtk stats`, the web UI, the benchmark and the README:
 * a single documented estimate is auditable, two estimates that disagree are
 * not.
 *
 * The formula is deliberately cheap and script-aware: ASCII-dense text (code,
 * JSON, English logs) prices at four characters per token, while CJK characters
 * and full-width forms price at 0.6 tokens each. A pure `bytes / 4` estimate is
 * about 25% high on Chinese output because every such character occupies three
 * UTF-8 bytes.
 *
 * @module dsh-rtk-workbench/tokens
 */

/** Characters outside the ASCII fast path: CJK, kana and full-width forms. */
function isWide(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
    (code >= 0x3040 && code <= 0x30ff) || // hiragana / katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // full-width forms
  )
}

/** Per-character price of a wide (CJK) character, in tokens. */
export const WIDE_TOKENS_PER_CHAR = 0.6

/** Per-character price of an ASCII-dense character, in tokens. */
export const NARROW_TOKENS_PER_CHAR = 0.25

/**
 * Estimate the tokens one piece of text occupies in a request.
 *
 * Counts UTF-16 code units: surrogate pairs (emoji) count twice as narrow
 * characters, which slightly overstates them — a documented approximation, not
 * a bug to chase.
 *
 * @param text - model-visible text, before or after compression.
 * @returns estimated tokens, rounded up; `0` for an empty string.
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let wide = 0
  for (let index = 0; index < text.length; index += 1) {
    if (isWide(text.charCodeAt(index))) wide += 1
  }
  const narrow = text.length - wide
  return Math.ceil(narrow * NARROW_TOKENS_PER_CHAR + wide * WIDE_TOKENS_PER_CHAR)
}

/**
 * Tokens saved by replacing `before` with `after`.
 *
 * Prices both sides instead of pricing the byte delta: mixed Chinese and English
 * text does not share one bytes-per-token ratio, and a compression that drops
 * ASCII while keeping CJK would otherwise look far better than it is.
 *
 * @param before - the text that would have reached the model.
 * @param after - the text that did.
 * @returns a non-negative estimate; `0` when the compression saved nothing.
 */
export function estimateSavedTokens(before: string, after: string): number {
  const saved = estimateTokens(before) - estimateTokens(after)
  return saved > 0 ? saved : 0
}

/**
 * Compact token count for one line of text (`12400` → `12.4k`).
 *
 * @param tokens - estimated token count.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}
