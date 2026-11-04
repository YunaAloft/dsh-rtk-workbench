/**
 * Token estimate used by the benchmark table.
 *
 * Mirrors `src/tokens.ts` exactly (`tests/benchmark-tokens.test.ts` asserts the
 * two agree). Kept as plain JavaScript so the benchmark can run without a build
 * step, and in its own module so the fixture script never becomes the second
 * source of truth for the formula.
 *
 * @param {string} text - text to price.
 * @returns {number} estimated tokens, rounded up.
 */
export function estimateTokens(text) {
  if (text === '') return 0
  let wide = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      wide += 1
    }
  }
  const narrow = text.length - wide
  return Math.ceil(narrow * 0.25 + wide * 0.6)
}
