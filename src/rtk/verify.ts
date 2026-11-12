/**
 * Semantic guard for `rtk rewrite` proposals.
 *
 * The cheap checks in {@link decideRewrite} prove that a proposal *looks* like
 * an rtk invocation (it carries an `rtk` segment, adds no control operator and
 * stays a sane length). None of them proves the proposal still runs the command
 * the caller asked for: rtk 1.2.0 drops arguments in a few mappings —
 * `next build` becomes `rtk next`, `python -m pytest` becomes `rtk pytest` — and
 * a dropped argument silently executes a different command.
 *
 * The guard is intentionally strict. It accepts:
 *
 * 1. a **prefix rewrite**: the segment is exactly `rtk <original segment>`;
 * 2. a **known mapping with preserved arguments**: `gradle …` →
 *    `rtk gradlew …`, `next build …` → `rtk next …` (rtk's `next` command always
 *    injects `build`, so dropping the word is not dropping an argument), and the
 *    `read` family (`cat`/`head`/`tail`/…) → `rtk read <path> [--head-lines N]`,
 *    where every non-flag token and every number from the original must survive.
 *
 * Everything else is rejected to the untouched original command. A rejected
 * rewrite costs the rtk inline compression for that call, but the post-execute
 * compression layer still runs on its output, so the guard never turns a
 * successful call into a broken one.
 *
 * @module dsh-rtk-workbench/rtk/verify
 */

import { splitSegments } from './segments'

/** Why a proposal was rejected. */
export type GuardReason = 'segment-mismatch' | 'env-mismatch' | 'tokens-dropped' | 'unknown-transform'

/** How a proposal was proven equivalent to the original command. */
export type GuardVia = 'prefix' | 'gradle' | 'next-build' | 'read' | 'unchanged'

/** Outcome of checking one proposal. */
export type GuardVerdict = { readonly ok: true; readonly via: GuardVia } | { readonly ok: false; readonly reason: GuardReason }

/** One `NAME=value` word in front of a segment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S+$/

/** Commands rtk maps to `rtk read`, where the mapping itself is legitimate. */
const READ_FAMILY: ReadonlySet<string> = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'type'])

/** Collapse runs of whitespace so the two sides compare structurally. */
function normalized(segment: string): string {
  return segment.trim().replace(/\s+/g, ' ')
}

/**
 * Peel leading environment assignments off one segment.
 *
 * A rewrite that adds an assignment (`git status` → `FOO=1 rtk git status`)
 * changes the command even when the tail looks identical, so the two sides must
 * carry the same prefix.
 *
 * @param segment - one normalized segment.
 */
function splitEnv(segment: string): { readonly env: readonly string[]; readonly rest: string } {
  const tokens = normalized(segment).split(' ')
  let index = 0
  while (index < tokens.length && ASSIGNMENT.test(tokens[index] ?? '')) index += 1
  return { env: tokens.slice(0, index), rest: tokens.slice(index).join(' ') }
}

/** Every run of digits in a token list (line-window flags keep their number). */
function digitsOf(tokens: readonly string[]): string[] {
  return tokens.flatMap((token) => token.match(/\d+/g) ?? [])
}

/** `git status` → `rtk git status`. */
function isPrefixRewrite(original: string, rewritten: string): boolean {
  return rewritten === `rtk ${original}`
}

/** `gradle build` → `rtk gradlew build` (arguments preserved verbatim). */
function isGradleMapping(original: string, rewritten: string): boolean {
  const from = original.split(' ')
  const to = rewritten.split(' ')
  if (from[0] !== 'gradle' || to[0] !== 'rtk' || to[1] !== 'gradlew') return false
  return from.slice(1).join(' ') === to.slice(2).join(' ')
}

/**
 * `next build [args]` → `rtk next [args]` (arguments preserved verbatim).
 *
 * `rtk next` is not a bare passthrough: its implementation always appends the
 * `build` subcommand before the caller's arguments (falling back to
 * `npx next build` when `next` is not on PATH), so the dropped word is not a
 * dropped argument. rtk 1.2.0 rewrites `next build` and nothing else, which is
 * why `next dev` never reaches this check.
 *
 * @param original - one normalized segment of the caller's command.
 * @param rewritten - the matching segment of rtk's proposal.
 */
function isNextBuildMapping(original: string, rewritten: string): boolean {
  const from = original.split(' ')
  const to = rewritten.split(' ')
  if (from[0] !== 'next' || from[1] !== 'build') return false
  if (to[0] !== 'rtk' || to[1] !== 'next') return false
  return from.slice(2).join(' ') === to.slice(2).join(' ')
}

/**
 * `head -20 f` → `rtk read f --head-lines 20` (path and numbers preserved).
 *
 * The family is excluded from rewriting by default; this entry only matters for
 * a user who removes those verbs from `rewriteExcludeCommands`.
 */
function isReadMapping(original: string, rewritten: string): boolean {
  const from = original.split(' ')
  const to = rewritten.split(' ')
  const verb = from[0] ?? ''
  if (!READ_FAMILY.has(verb)) return false
  if (to[0] !== 'rtk' || to[1] !== 'read') return false
  const files = from.slice(1).filter((token) => !token.startsWith('-'))
  const mapped = to.slice(2)
  if (files.length === 0) return false
  if (!files.every((token) => mapped.includes(token))) return false
  return digitsOf(from.slice(1)).every((digit) => digitsOf(mapped).includes(digit))
}

/**
 * Check one `rtk rewrite` proposal against the command it claims to replace.
 *
 * @param original - the command the caller asked for.
 * @param rewritten - rtk's proposal, as printed on stdout.
 * @returns whether the proposal may be executed.
 */
export function verifyRewrite(original: string, rewritten: string): GuardVerdict {
  const fromSegments = splitSegments(original)
  const toSegments = splitSegments(rewritten)
  if (fromSegments.length === 0 || fromSegments.length !== toSegments.length) {
    return { ok: false, reason: 'segment-mismatch' }
  }

  let via: GuardVia = 'unchanged'
  for (let index = 0; index < fromSegments.length; index += 1) {
    const from = splitEnv(fromSegments[index] ?? '')
    const to = splitEnv(toSegments[index] ?? '')
    if (from.env.join(' ') !== to.env.join(' ')) return { ok: false, reason: 'env-mismatch' }
    if (to.rest === from.rest) continue
    if (isPrefixRewrite(from.rest, to.rest)) {
      if (via === 'unchanged') via = 'prefix'
      continue
    }
    if (isGradleMapping(from.rest, to.rest)) {
      if (via === 'unchanged') via = 'gradle'
      continue
    }
    if (isNextBuildMapping(from.rest, to.rest)) {
      if (via === 'unchanged') via = 'next-build'
      continue
    }
    if (isReadMapping(from.rest, to.rest)) {
      if (via === 'unchanged') via = 'read'
      continue
    }
    const dropped = from.rest.split(' ').some((token) => !to.rest.includes(token))
    return { ok: false, reason: dropped ? 'tokens-dropped' : 'unknown-transform' }
  }

  return { ok: true, via }
}
