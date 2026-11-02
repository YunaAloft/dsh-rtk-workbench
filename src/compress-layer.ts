import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Config } from './config'
import { compressWithRtk, pickShape } from './rtk/compress'
import { commandOf, decideTool, pathOf } from './toolmap'

type AcceptDecision = Extract<PostToolDecision, { kind: 'accept' }>
type Blocks = NonNullable<AcceptDecision['content']>

/** Content that already shows a compression (or another plugin's) mark. */
const ALREADY_MARKED = /\[rtk\b|\[ACP\b|\[x\d+\]|\(\d+ filtered\)|\[spill\b|rtk recall [0-9a-f]{6,}/i

/** Everything the compression layer needs from the surrounding plugin. */
export interface CompressLayerOptions {
  readonly binary: string
  readonly timeoutMs: number
  readonly env: NodeJS.ProcessEnv
  readonly config: Config
  /**
   * Session directory for one call. rtk attributes a saving to the project of
   * its own process cwd, so the hook child has to run in the session directory.
   */
  readonly cwdOf?: (exec: ToolExecution) => string | undefined
  /** Per-call budget (the cold-start budget applies until the probe settles). */
  readonly timeoutOf?: () => number
  /** Optional sink for timing diagnostics (`RTK_WORKBENCH_DEBUG=1`). */
  readonly log?: (message: string) => void
  /**
   * Called once per result whose content a *downstream* listener already
   * replaced. This is the only reliable, name-free signal that another result
   * transformer shares the waterfall.
   */
  readonly onForeignTransform?: () => void
}

/** Extract the plain text of a result when every block is text. */
function textOf(blocks: readonly { type: string; text?: string }[]): string | undefined {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string') return undefined
    parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Whether a downstream decision replaced the value instead of the content. */
function replacedValue(decision: PostToolDecision): boolean {
  return decision.kind === 'accept' && Object.hasOwn(decision, 'value')
}

/**
 * Build the `tools/post-execute` listener.
 *
 * Invariants (each one is a bug that has already existed):
 *
 * 1. `next()` is always awaited first. Returning without it short-circuits every
 *    listener behind us — cc-safety-net's "not checked" notice, the spill policy.
 * 2. We transform the content the *downstream* decision carries, not the raw
 *    dispatch result: another listener may already have replaced it.
 * 3. A downstream `value` replacement wins; we never override it with content.
 * 4. Text is extracted whenever we are going to annotate too — annotating must
 *    never replace an unreadable result with an annotation-only body.
 * 5. Nothing here may throw: a throwing listener turns success into `isError`.
 */
export function createCompressLayer(options: CompressLayerOptions) {
  const { binary, timeoutMs, env, config } = options

  /**
   * Compress and/or annotate one settled tool result.
   *
   * @param exec - the call that just ran.
   * @param result - the normalized dispatch result (for `isError` only).
   * @param content - the content to transform (downstream decision applied).
   * @param rewrite - `[rtk] ran:` information when this call was rewritten.
   */
  async function run(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    content: Blocks,
    rewrite: { readonly from: string; readonly to: string; readonly fallback?: boolean } | undefined,
  ): Promise<Blocks | undefined> {
    // A PTC sub-call result reaches the program, not the model, unless the outer
    // run_code prints it; touching it would only cost a spawn.
    if (exec.parent !== undefined) return undefined

    const decision = decideTool(exec.name, config)
    const wantsAnnotation = rewrite !== undefined && config.annotateRewrites
    const text = textOf(content)
    options.log?.(
      `result ${exec.name}: isError=${String(result.isError)} blocks=${String(content.length)} text=${String(text?.length ?? -1)} compress=${String(decision.compress)} annotate=${String(wantsAnnotation)}`,
    )
    if (!decision.compress && !wantsAnnotation) return undefined
    // Never turn a failed, bodyless result into an annotation-only body: the
    // model would lose the failure text and see a command that "printed nothing".
    if (result.isError && (text === undefined || text === '')) return undefined
    const command = commandOf(exec.arguments)
    const path = pathOf(exec.arguments)

    let compressed: string | null = null
    if (decision.compress && !result.isError && text !== undefined) {
      const worthIt =
        text.length >= config.compressThresholdBytes &&
        text.length <= config.maxPayloadBytes &&
        !ALREADY_MARKED.test(text)
      if (worthIt) {
        const started = Date.now()
        const cwd = options.cwdOf?.(exec)
        compressed = await compressWithRtk({
          binary,
          shape: pickShape(path, text),
          // The REWRITTEN command: rtk's `is_rtk_command` gate reads it to skip
          // output rtk itself already produced (m0-findings §1 E1d).
          command: rewrite?.to ?? command ?? '',
          path: path ?? '',
          text,
          env,
          timeoutMs: options.timeoutOf?.() ?? timeoutMs,
          signal: exec.signal,
          ...(cwd === undefined ? {} : { cwd }),
        })
        options.log?.(
          `compress ${exec.name}: ${String(text.length)} -> ${String(compressed?.length ?? 0)} B in ${String(Date.now() - started)} ms`,
        )
      }
    }

    const body = compressed ?? text
    // The annotation names a ~130-character absolute path. On a short result it
    // costs more than the rewrite saved, so it is only added once the body is
    // large enough to make it noise; `/rtk status` still records the rewrite.
    // Non-text results have no comparable size — keep the signal there.
    const annotation =
      wantsAnnotation && rewrite !== undefined && (body === undefined || body.length >= config.annotateMinBytes)
        ? rewrite.fallback === true
          ? `[rtk] fell back: ${rewrite.from}`
          : `[rtk] ran: ${rewrite.to}`
        : undefined
    if (annotation === undefined && compressed === null) return undefined

    // Unreadable content (images, mixed blocks): prepend the annotation as its
    // own block rather than pretending the rest is text.
    if (body === undefined) {
      return annotation === undefined ? undefined : [{ type: 'text', text: annotation }, ...content]
    }

    return [{ type: 'text', text: annotation === undefined ? body : `${annotation}\n${body}` }]
  }

  return {
    /**
     * The registered `tools/post-execute` listener.
     *
     * @param exec - the call that just ran.
     * @param result - its normalized result.
     * @param next - the remaining listeners; always awaited.
     * @param rewriteOf - rewrites recorded by the rewrite layer for this call.
     */
    async listener(
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
      rewriteOf: (
        exec: object,
      ) => { readonly from: string; readonly to: string; readonly fallback?: boolean } | undefined,
    ): Promise<PostToolDecision> {
      const base = await next()
      try {
        if (base.kind !== 'accept') return base
        // A downstream `value` replacement re-renders the result; overriding it
        // with content would silently discard their decision.
        if (replacedValue(base)) return base
        const content = base.content ?? result.content
        if (base.content !== undefined && base.content !== result.content) options.onForeignTransform?.()
        const blocks = await run(exec, result, content, rewriteOf(exec))
        if (blocks === undefined) return base
        // Rebuild the content-carrying accept variant explicitly: spreading the
        // union member would keep the `content?: never` branch in play.
        return {
          kind: 'accept',
          content: blocks,
          ...(base.additionalContexts !== undefined ? { additionalContexts: base.additionalContexts } : {}),
        }
      } catch {
        return base
      }
    },
  }
}
