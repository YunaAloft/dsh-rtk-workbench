/**
 * Shell command segmentation shared by the rewrite pre-filter and the
 * semantic guard.
 *
 * Both sides of a rewrite decision must agree on where a command splits: the
 * pre-filter asks "is any segment worth rewriting?", the guard asks "did every
 * rewritten segment keep its original command?". One splitter keeps the two
 * answers from drifting apart.
 */

/**
 * Split a command line into top-level segments on `&&`, `||`, `;`, `|` and
 * newlines.
 *
 * Deliberately simple: quoting is not interpreted, so a `|` inside a quoted
 * string still splits. That only costs an extra "not worth rewriting" decision
 * (safe), never a wrong execution.
 *
 * @param command - shell command line.
 * @returns trimmed, non-empty segments in source order.
 */
export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}
