/**
 * Shell command segmentation shared by the rewrite pre-filter and the
 * semantic guard.
 *
 * Both sides of a rewrite decision must agree on where a command splits: the
 * pre-filter asks "is any segment worth rewriting?", the guard asks "did every
 * rewritten segment keep its original command?". One splitter keeps the two
 * answers from drifting apart.
 */

/** One top-level command segment and the operator that introduced it. */
export interface CommandSegment {
  readonly text: string
  /** Operator before this segment (`&&`, `||`, `;`, `|` or a newline). */
  readonly opBefore?: string
}

/**
 * Split a command line into top-level segments while keeping the separators, so
 * a partially accepted proposal can be reassembled with the caller's original
 * operators.
 *
 * Deliberately simple: quoting is not interpreted, so a `|` inside a quoted
 * string still splits. That only costs an extra "not worth rewriting" decision
 * (safe), never a wrong execution.
 *
 * @param command - shell command line.
 */
export function splitSegmentsWithSeparators(command: string): CommandSegment[] {
  const parts = command.split(/(&&|\|\||[;|\n])/)
  const segments: CommandSegment[] = []
  let opBefore: string | undefined
  for (const part of parts) {
    if (/^(?:&&|\|\||[;|\n])$/.test(part)) {
      opBefore = part
      continue
    }
    const text = part.trim()
    if (text === '') continue
    segments.push({ text, ...(opBefore === undefined ? {} : { opBefore }) })
    opBefore = undefined
  }
  return segments
}

/**
 * Split a command line into top-level segments on `&&`, `||`, `;`, `|` and
 * newlines.
 *
 * @param command - shell command line.
 * @returns trimmed, non-empty segments in source order.
 */
export function splitSegments(command: string): string[] {
  return splitSegmentsWithSeparators(command).map((segment) => segment.text)
}
