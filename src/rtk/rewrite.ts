import type { Dialect } from '../toolmap'
import { splitSegments } from './segments'
import { verifyRewrite } from './verify'

export { splitSegments } from './segments'

/** rtk `rewrite` exit-code semantics, verified from `src/hooks/rewrite_cmd.rs:73-123`. */
export const REWRITE_ALLOW = 0
export const REWRITE_DEFER = 1
export const REWRITE_DENY = 2
export const REWRITE_ASK = 3

/** What one `rtk rewrite` call decided. */
export type RewriteOutcome =
  | { readonly kind: 'rewrite'; readonly command: string }
  | { readonly kind: 'none'; readonly reason: 'no-equivalent' | 'denied' | 'empty' | 'unsafe' | 'guard' }

/** Operators whose appearance in a rewrite that the original lacked is treated as unsafe. */
const CONTROL_OPERATORS = [';', '&&', '||', '|', '$(', '`', '>>', '<<'] as const

/**
 * Whether `rewritten` introduces a shell operator the original command did not
 * have. `rtk rewrite` is expected to be a pure prefix transform (`git status` →
 * `rtk git status`, or a segment-wise transform of a compound command), so a
 * newly appearing operator means the answer is not the shape we sanctioned.
 *
 * @param original - the command the model wrote.
 * @param rewritten - the command rtk proposed.
 */
export function introducesNewOperators(original: string, rewritten: string): boolean {
  for (const op of CONTROL_OPERATORS) {
    if (rewritten.includes(op) && !original.includes(op)) return true
  }
  return false
}

/**
 * Whether a proposed command actually invokes rtk.
 *
 * A single-segment rewrite is `rtk git status`; a compound one is rewritten
 * segment by segment (`cd repo && rtk cargo test`), so the whole string does not
 * necessarily start with `rtk`. What must hold is that at least one segment
 * begins with the rtk binary — otherwise the proposal is not an rtk rewrite at
 * all and there is no reason to execute it over the original.
 */
export function hasRtkSegment(command: string): boolean {
  return splitSegments(command).some((segment) => isRtkInvocation(segment))
}

/** Leading `NAME=value` assignments, quoted or bare, before the command word. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/

/** Remove any leading environment assignments from one segment. */
function stripEnvAssignments(segment: string): string {
  let rest = segment.trimStart()
  for (;;) {
    const match = ENV_ASSIGNMENT.exec(rest)
    if (match === null) return rest
    rest = rest.slice(match[0].length)
  }
}

/** First word of a segment, with one layer of matching quotes removed. */
function firstWord(segment: string): string {
  const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(segment.trimStart())
  if (match === null) return ''
  return match[1] ?? match[2] ?? match[3] ?? ''
}

/** Basename without a `.exe` suffix, for comparing one command word. */
function commandBase(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word
  return base.replace(/\.exe$/i, '')
}

/**
 * Whether one shell segment already invokes rtk.
 *
 * The check has to survive what shells and users actually write around a
 * command: environment prefixes (`FOO=1 rtk …`), quoted command words
 * (`"rtk" …`), absolute or Windows paths, an `.exe` suffix and a different case
 * on Windows. Missing one of those only costs an unnecessary `rtk rewrite`
 * spawn (~206 ms) and returns the command unchanged, but the pre-filter exists
 * precisely to avoid paying that.
 *
 * @param segment - one operator-delimited segment of a shell command.
 */
export function isRtkInvocation(segment: string): boolean {
  const word = firstWord(stripEnvAssignments(segment))
  if (word === '') return false
  return commandBase(word).toLowerCase() === 'rtk'
}

/**
 * Arguments for the `rtk rewrite` call.
 *
 * A command whose first character is `-` (`-h`, `--help`) would otherwise be
 * read by rtk's own clap parser as a flag: it prints help and exits 0, and the
 * help text then looks like an allowed rewrite. `--` ends option parsing so the
 * command is always treated as data.
 *
 * @param command - the command the model asked for.
 */
export function rewriteInvocation(command: string): string[] {
  return command.trimStart().startsWith('-') ? ['rewrite', '--', command] : ['rewrite', command]
}

/**
 * Point every rewritten segment at the resolved binary instead of bare `rtk`.
 *
 * `rtk rewrite` answers `rtk git status`, which only works when `rtk` is on the
 * shell's PATH. A user who relies on the binary bundled with this package has no
 * such PATH entry, so the rewrite would fail with "command not found" — the
 * plugin must substitute the path it actually resolved.
 *
 * The substitution is dialect-aware because the shells disagree about how a
 * quoted path becomes a command:
 *
 * - POSIX: `'path' git status` is an ordinary command word.
 * - PowerShell: a quoted path is a *string expression*, so `"path" git status` is
 *   a parse error ("missing terminator") and the call operator is mandatory:
 *   `& 'path' git status`. The `|` form is left alone because PowerShell rejects
 *   `… | & 'path' args` outright; rtk does not produce that shape itself.
 *
 * Forward slashes keep the same string valid in pwsh, cmd and MSYS bash.
 *
 * @param command - the command rtk proposed.
 * @param binary - the binary this plugin resolved (`rtk` means PATH, untouched).
 * @param dialect - shell that will run the result.
 */
export function absolutizeRtk(command: string, binary: string, dialect: Dialect = 'posix'): string {
  const trimmed = binary.trim()
  if (trimmed === '' || trimmed === 'rtk') return command
  const slashed = trimmed.replace(/\\/g, '/')
  // A directory may legally contain an apostrophe ("Bob's tools"), which would
  // terminate a single-quoted word early. Fall back to double quotes — valid for
  // both PowerShell's call operator and POSIX — and give up if the path carries
  // both quote characters, rather than emitting a command that cannot parse.
  if (slashed.includes('"') && slashed.includes("'")) return command
  const quoted = slashed.includes("'") ? `"${slashed}"` : `'${slashed}'`
  if (dialect === 'powershell') {
    return command.replace(
      /(^|&&|\|\||[;\n])(\s*)rtk(?=\s|$)/g,
      (_match, operator: string, space: string) => `${operator}${space}& ${quoted}`,
    )
  }
  return command.replace(
    /(^|&&|\|\||[;|\n])(\s*)rtk(?=\s|$)/g,
    (_match, operator: string, space: string) => `${operator}${space}${quoted}`,
  )
}

/**
 * Decide whether a `rtk rewrite` result may be executed.
 *
 * The cheap guards exist because the proposed command is data produced by an
 * external binary: executing it unchecked would outsource "what runs" to that
 * binary. The semantic guard goes one step further and checks that the proposal
 * still runs the *same* command — rtk 1.2.0 drops arguments in some mappings
 * (`next build` → `rtk next`), which the shape checks cannot see.
 *
 * @param original - command the model asked for.
 * @param run - raw rtk invocation outcome (`null` = timed out / aborted).
 * @param options - `semanticGuard: false` disables the token-preservation check.
 */
export function decideRewrite(
  original: string,
  run: { readonly code: number | null; readonly stdout: string } | null,
  options: { readonly semanticGuard?: boolean } = {},
): RewriteOutcome {
  if (run === null) return { kind: 'none', reason: 'no-equivalent' }
  const { code, stdout } = run
  const candidate = stdout.trim()
  // 0 = allow, 3 = ask (including rtk's "Default" verdict, which is most calls).
  if (code !== REWRITE_ALLOW && code !== REWRITE_ASK) {
    return { kind: 'none', reason: code === REWRITE_DENY ? 'denied' : 'no-equivalent' }
  }
  if (candidate === '') return { kind: 'none', reason: 'empty' }
  // rtk handing back the original verbatim means "nothing to rewrite", which is
  // not a safety problem and should not be reported as one.
  if (candidate === original.trim()) return { kind: 'none', reason: 'empty' }
  if (!hasRtkSegment(candidate)) return { kind: 'none', reason: 'unsafe' }
  if (introducesNewOperators(original, candidate)) return { kind: 'none', reason: 'unsafe' }
  if (candidate.length > Math.max(4096, original.length * 8)) return { kind: 'none', reason: 'unsafe' }
  if (options.semanticGuard !== false && !verifyRewrite(original, candidate).ok) {
    return { kind: 'none', reason: 'guard' }
  }
  return { kind: 'rewrite', command: candidate }
}

/** PowerShell statement keywords — never an external program, so rtk cannot rewrite them. */
const POWERSHELL_KEYWORDS = new Set([
  'if', 'else', 'elseif', 'foreach', 'for', 'while', 'do', 'switch', 'function', 'param',
  'return', 'try', 'catch', 'finally', 'throw', 'trap', 'begin', 'process', 'end', 'class',
  'enum', 'using', 'break', 'continue', 'exit', 'filter', 'workflow',
])

/**
 * Whether the first token is PowerShell-only syntax rather than an external
 * program call.
 *
 * Windows users drive the `pwsh` tool, and the interesting commands there are
 * still ordinary executables (`git status`, `cargo test`, `docker ps`, `ls`) —
 * rtk rewrites those. Cmdlets (`Get-ChildItem`), variables (`$env:PATH`),
 * subexpressions and call operators are PowerShell grammar; rtk defers on them,
 * so asking would only spend the ~200 ms spawn for a guaranteed "no".
 *
 * @param first - first whitespace-separated token of one command segment.
 */
export function isPowershellOnly(first: string): boolean {
  if (/^[A-Za-z]+-[A-Za-z]+$/.test(first)) return true // Verb-Noun cmdlet
  if (/^[$@(&!#]/.test(first)) return true // variable, splat, subexpression, call, comment
  return POWERSHELL_KEYWORDS.has(first.toLowerCase())
}

/** Commands that can never become an rtk call, so the ~206 ms spawn is skipped. */
const BUILTIN_ONLY = new Set([
  'cd',
  'echo',
  'export',
  'set',
  'unset',
  'true',
  'false',
  'exit',
  'return',
  'shift',
  'wait',
  'source',
  '.',
  ':',
  'pwd',
])

/**
 * Cheap pre-filter, mirroring the rule the mature community implementations use:
 * skip only when *every* segment is uninteresting — a shell builtin, an excluded
 * command, or already an rtk call. Anything not provably unroutable is handed to
 * rtk, which then decides.
 *
 * @param command - candidate command string.
 * @param dialect - shell dialect the tool speaks; PowerShell defers on its own grammar.
 * @param exclude - command words that must not justify a rewrite (default: none).
 */
export function isWorthRewriting(
  command: string,
  dialect: Dialect = 'posix',
  exclude: ReadonlySet<string> = new Set(),
): boolean {
  const segments = splitSegments(command)
  if (segments.length === 0) return false
  return segments.some((segment) => {
    if (isRtkInvocation(segment)) return false
    const stripped = stripEnvAssignments(segment)
    const first = firstWord(stripped)
    if (first === '') return false
    if (BUILTIN_ONLY.has(first)) return false
    // `rtk rewrite "cat big.log"` yields `rtk read big.log`, which filters nothing
    // for a log *and* makes rtk skip its own posthook for that call — so the one
    // transformation that would have paid off (compression) never runs. Leaving
    // these commands raw is strictly better than a rewrite that only moves bytes.
    if (exclude.has(first)) return false
    if (dialect === 'powershell' && isPowershellOnly(first)) return false
    return true
  })
}

/**
 * The command word that identifies a verb for session-level bookkeeping.
 *
 * Uses the same first-segment/first-token rule as {@link isWorthRewriting} and
 * normalises a path or `.exe` suffix so `C:/x/git.exe` and `git` share one key.
 *
 * @param command - a shell command line.
 * @returns the verb, or `undefined` for an empty command.
 */
export function verbOf(command: string): string | undefined {
  const segment = splitSegments(command)[0]
  if (segment === undefined) return undefined
  const word = firstWord(stripEnvAssignments(segment))
  if (word === '') return undefined
  return commandBase(word).toLowerCase() || undefined
}

/**
 * Serialise a tool result for failure inspection, bounded so a huge body never
 * becomes part of the decision.
 *
 * @param value - whatever `ToolDefinition.execute` returned.
 * @param maxBytes - cap on the inspected text.
 */
export function resultText(value: unknown, maxBytes = 64 * 1024): string {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.slice(0, maxBytes) : ''
  } catch {
    return ''
  }
}

/**
 * Whether a tool result is rtk's *own* failure rather than the proxied command's.
 *
 * Deliberately narrow. A failed `git status` inside a valid repository prints
 * git's error and must not be retried (side effects); this only matches the
 * signature rtk itself emits when it cannot start or run the command it wraps:
 * `rtk: Failed to run <cmd>: Failed to spawn process: … (os error 5)`.
 *
 * @param text - serialised result (see {@link resultText}).
 */
export function looksLikeRtkFailure(text: string): boolean {
  if (!text.includes('rtk:')) return false
  return (
    /rtk: Failed to (?:run|execute|spawn)\b/.test(text) ||
    /rtk: [^\n]{0,200}Failed to spawn process/.test(text) ||
    /rtk: [^\n]{0,200}(?:os error 5|Access is denied|拒绝访问)/.test(text)
  )
}
