/**
 * Shell wrappers rtk treats as transparent when it inserts itself.
 *
 * The same tokenisation and head list feed the pre-filter (skip a wrapper that
 * already contains rtk) and the semantic guard (accept only a literal wrapper
 * parameter list plus the untouched inner command). Keeping one definition
 * stops the two sides from disagreeing about what "wrapped" means.
 */

/** Accepted wrapper heads. `command`, `builtin` and `exec` are deliberately absent. */
const HEADS: ReadonlyArray<readonly string[]> = [
  ['env'],
  ['timeout'],
  ['time'],
  ['nohup'],
  ['nice'],
  ['uv', 'run'],
  ['nocorrect'],
  ['noglob'],
]

/** Whitespace-normalised tokens of one command segment. */
function tokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter((token) => token !== '')
}

/** Length of the wrapper head at the start of `parts`, or 0 when none matches. */
function headLength(parts: readonly string[]): number {
  for (const head of HEADS) {
    if (head.every((word, index) => parts[index] === word)) return head.length
  }
  return 0
}

/**
 * Index of the `rtk` token a wrapper introduces, or `undefined`.
 *
 * Requires the segment to start with a known wrapper head and contain `rtk` at
 * a later token boundary. Tokens between the head and `rtk` are the wrapper's
 * parameters, which {@link isWrapperRewrite} requires to be preserved.
 *
 * @param segment - one command segment.
 */
export function wrapperRtkIndex(segment: string): number | undefined {
  const parts = tokens(segment)
  const start = headLength(parts)
  if (start === 0) return undefined
  for (let index = start; index < parts.length; index += 1) {
    if (parts[index] === 'rtk') return index
  }
  return undefined
}

/** Whether one segment is `<wrapper> … rtk …` (already rewritten). */
export function isWrapperRtkInvocation(segment: string): boolean {
  return wrapperRtkIndex(segment) !== undefined
}

/**
 * Whether `rewritten` is `original` with `rtk` inserted inside a known wrapper,
 * with the wrapper parameters and the inner command preserved token for token.
 *
 * @param original - one normalized segment of the caller's command.
 * @param rewritten - the matching segment of rtk's proposal.
 */
export function isWrapperRewrite(original: string, rewritten: string): boolean {
  const from = tokens(original)
  const to = tokens(rewritten)
  const index = wrapperRtkIndex(rewritten)
  if (index === undefined) return false
  const before = to.slice(0, index)
  const after = to.slice(index + 1)
  if (after.length === 0) return false
  if (from.length !== before.length + after.length) return false
  const expected = [...before, ...after]
  return expected.every((token, position) => token === from[position])
}
