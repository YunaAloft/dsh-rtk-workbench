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
 *
 * The section is only registered once the start-up probe has proven that rtk can
 * compress at all — telling the model "output may be condensed" while the
 * binary is unusable is worse than saying nothing.
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
    'Some shell commands are rewritten to `rtk <command>`; the result then starts with `[rtk] ran:`.',
    'If rtk itself could not run the rewrite, the result says `[rtk] fell back:` and the original ran.',
    '',
    'A truncated result states how to recover the original in its own text: usually `rtk recall <hash>`,',
    'sometimes a saved path you can read. If `rtk recall` fails with a store or schema error, your shell',
    'is sandboxed away from rtk’s database — ask the user to run `/rtk recall <hash>` instead.',
    '',
    'Condensation applies to tool output only. When you answer the user, do not shorten the report',
    'because of it: keep the numbers, caveats and warnings they asked for — never drop a caveat to save space.',
    '',
    'The user can see what was saved with `/rtk status` (this session) or `/rtk gain` (rtk-wide).',
    'Only if a result is unusable — empty when output was clearly expected, contradicting its exit code,',
    'or garbled — re-run it as `rtk bypass <your command>`.',
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
