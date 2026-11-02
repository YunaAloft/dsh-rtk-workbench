import { runRtk } from './exec'

/** Content format rtk should see for one tool result. */
export type ResultShape = 'read' | 'bash'

/** Lockfile basenames rtk serves with its `lockfile` method (`posthook.rs:937`). */
const LOCKFILES = new Set(['package-lock.json', 'Cargo.lock', 'yarn.lock', 'pnpm-lock.yaml'])

/**
 * Pick the rtk response shape for a tool result.
 *
 * `read` only pays off for lockfiles and JSON: rtk's `read` evaluator maps plain
 * text to `term`, where no shipped rule matches, so an ordinary source file
 * would come back untouched. Everything else therefore travels the `bash` shape
 * and gets the `term` chain (ansi → progress → dedup → base64-elide → cap),
 * which is a pure text transform and does not care where the bytes came from.
 *
 * @param path - file path when the call has one.
 * @param text - the result text.
 */
export function pickShape(path: string | undefined, text: string): ResultShape {
  const base = (path ?? '').split(/[\\/]/).pop() ?? ''
  if (LOCKFILES.has(base)) return 'read'
  if (base.endsWith('.json')) return 'read'
  // A pathless body always travels the `bash` shape: rtk classifies the `read`
  // format from the file extension, so without a path it would resolve to `term`
  // and no rule would fire — a wasted spawn.
  return 'bash'
}

/**
 * Build the Claude Code `PostToolUse` event rtk's posthook adapter expects.
 *
 * The tool name MUST be one rtk's harness profile knows (`Bash`/`Read`); an
 * unrecognized name maps to `Subject::Any`, whose generic extractor cannot read
 * this response shape and silently emits nothing (measured: m0-findings §1 E1c).
 *
 * @param shape - which response shape to emit.
 * @param command - effective shell command (the REWRITTEN one when available, so
 *   rtk's `is_rtk_command` gate skips already-compressed output).
 * @param path - file path for the `read` shape.
 * @param text - result text.
 */
export function buildPostToolUsePayload(
  shape: ResultShape,
  command: string,
  path: string,
  text: string,
): string {
  const lines = text.split('\n').length
  const payload =
    shape === 'read'
      ? {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: path },
          tool_response: { type: 'text', file: { content: text, numLines: lines, totalLines: lines } },
        }
      : {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          tool_response: { stdout: text, stderr: '', interrupted: false },
        }
  return JSON.stringify(payload)
}

/** What one hook response carries: the rewritten text and any model-facing note. */
export interface HookOutput {
  readonly text: string
  /**
   * `hookSpecificOutput.additionalContext`. rtk sets it when it *converted* a
   * Read output (json→toon, lockfile summary), warning that the on-disk file
   * no longer matches the text — using the converted body as an `old_string`
   * would produce a failed edit.
   */
  readonly note?: string
}

/** One parsed hook response; `null` when the payload is not the documented shape. */
export function extractHookOutput(shape: ResultShape, stdout: string): HookOutput | null {
  const trimmed = stdout.trim()
  if (trimmed === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const hook = (parsed as { hookSpecificOutput?: Record<string, unknown> })?.hookSpecificOutput
  const updated = hook?.updatedToolOutput as Record<string, unknown> | undefined
  if (updated === undefined || updated === null) return null

  let text: string | null
  if (shape === 'read') {
    const file = updated.file as { content?: unknown } | undefined
    text = typeof file?.content === 'string' ? file.content : null
  } else {
    const out = updated.stdout
    if (typeof out !== 'string') {
      text = null
    } else {
      const err = typeof updated.stderr === 'string' ? updated.stderr : ''
      text = err === '' ? out : `${out}\n${err}`
    }
  }
  if (text === null) return null

  const rawNote = hook?.additionalContext
  const note = typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote.trim() : undefined
  return note === undefined ? { text } : { text, note }
}

/** The text rtk put back, per shape. `null` when the response is not the documented one. */
export function extractUpdatedText(shape: ResultShape, stdout: string): string | null {
  return extractHookOutput(shape, stdout)?.text ?? null
}

/**
 * Run one compression round trip.
 *
 * @returns the compressed text, or `null` for "keep the original" — which covers
 * a missing binary, a timeout, an unrecognized response, and rtk deciding the
 * result was not worth touching.
 */
export async function compressWithRtk(options: {
  readonly binary: string
  readonly shape: ResultShape
  readonly command: string
  readonly path: string
  readonly text: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /**
   * Working directory for the hook child. rtk records the project of one call
   * from its own process cwd, so the session directory makes the saving
   * attributable to the project the user is actually working in.
   */
  readonly cwd?: string
}): Promise<HookOutput | null> {
  const payload = buildPostToolUsePayload(options.shape, options.command, options.path, options.text)
  const run = await runRtk(options.binary, ['hook', 'claude'], {
    input: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    env: options.env,
    maxBytes: options.text.length * 2 + 64 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
  if (run.failure !== undefined || run.code !== 0) return null
  const updated = extractHookOutput(options.shape, run.stdout)
  if (updated === null) return null
  // Defensive: rtk already refuses to emit a non-improvement (`never_worse`),
  // but a future rule could still hand back something larger than the input.
  if (updated.text.length >= options.text.length) return null
  return updated
}
