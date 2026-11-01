/**
 * The awareness section injected into the system prompt.
 *
 * Deliberately static: the section is part of the prompt prefix, so any
 * per-turn variation would invalidate the provider's KV cache. It also states
 * the DSH-specific facts rather than copying rtk's own `hooks/rtk-awareness.md`
 * verbatim — that file assumes rtk rewrote the command itself, while here the
 * compression happens to tool output and the rewrite switch can be off.
 *
 * When `tools/post-execute` replaces content the canonical value is preserved,
 * so the model sees this condensed view while `run_code` programs still get the
 * full value; the recall hint travels inside the condensed text itself.
 */
export const AWARENESS_SECTION_NAME = 'rtk-workbench:output'

/** Build the section text. Kept pure so tests can pin it byte for byte. */
export function awarenessText(): string {
  return [
    '# Tool output',
    '',
    'Tool output in this session may be condensed by rtk (Rust Token Killer) before you read it:',
    'ANSI escapes, progress bars and repeated lines are removed, and very long output is capped.',
    'Treat condensed output as the complete result — do not re-run a command to see it unfiltered.',
    '',
    'A truncated result states how to recover the original in its own text, usually',
    '`rtk recall <hash>`. Some shell commands are also rewritten to `rtk <command>`; when that',
    'happens the result starts with a `[rtk] ran: …` line naming the command that actually ran.',
    '',
    'If `rtk recall` fails with a store or schema error, your shell is sandboxed away from rtk’s',
    'database: ask the user to run `/rtk recall <hash>` instead — slash commands run outside it.',
    '',
    'Only if a result is unusable — empty when output was clearly expected, contradicting its',
    'exit code, or garbled — re-run it as `rtk bypass <your command>`.',
  ].join('\n')
}

/** Minimal structural view of `ctx.systemPrompt`, so no hard package dependency is needed. */
export interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string
    readonly interpolate?: boolean
  }): () => void
}

/** Sort order: late in the prompt, after tool descriptions. */
export const AWARENESS_ORDER = 9000
