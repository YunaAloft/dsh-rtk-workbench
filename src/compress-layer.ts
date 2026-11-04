import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Config } from './config'
import { compressWithRtk, pickShape, type HookOutput } from './rtk/compress'
import { verbOf } from './rtk/rewrite'
import type { SkipReason } from './stats'
import { estimateSavedTokens } from './tokens'
import { commandOf, decideTool, pathOf, patternOf } from './toolmap'

type AcceptDecision = Extract<PostToolDecision, { kind: 'accept' }>
type Blocks = NonNullable<AcceptDecision['content']>

/**
 * Content that already shows a compression (or another plugin's) mark.
 *
 * `content trimmed to save tokens` / `full diff: rtk` / `head and tail
 * preserved` are dsh-token-saver's markers: co-installing it would otherwise
 * let this layer trim already-trimmed text a second time.
 */
const ALREADY_MARKED =
  /\[rtk\b|\[ACP\b|\[x\d+\]|\(\d+ filtered\)|\[spill\b|rtk recall [0-9a-f]{6,}|content trimmed to save tokens|full diff: rtk|head and tail preserved/i

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
  /** Injectable round trip; tests replace it to observe the decision only. */
  readonly compress?: typeof compressWithRtk
  /**
   * Spill the pre-compression text. The plugin decides whether this environment
   * needs it (sandboxed shell, broken recall store, no recall hint); returning
   * `undefined` leaves rtk's own hint in place.
   */
  readonly spillOf?: (
    exec: ToolExecution,
    text: string,
    rtkOfferedRecall: boolean,
  ) => Promise<string | undefined>
  /** Optional sink for timing diagnostics (`RTK_WORKBENCH_DEBUG=1`). */
  readonly log?: (message: string) => void
  /** Session counters: one call per compression pass. */
  readonly onCompressed?: (
    exec: ToolExecution,
    inBytes: number,
    outBytes: number,
    savedTokens: number,
    ms: number,
  ) => void
  /** Session counters: one call per deliberately skipped result. */
  readonly onSkipped?: (exec: ToolExecution, reason: SkipReason) => void
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
  const roundTrip = options.compress ?? compressWithRtk

  /**
   * Compress and/or annotate one settled tool result.
   *
   * @param exec - the call that just ran.
   * @param result - the normalized dispatch result (for `isError` only).
   * @param content - the content to transform (downstream decision applied).
   * @param rewrite - rewrite information when this call was rewritten.
   */
  async function run(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    content: Blocks,
    rewrite:
      | { readonly from: string; readonly to: string; readonly proposal?: string; readonly fallback?: boolean }
      | undefined,
  ): Promise<Blocks | undefined> {
    // A PTC sub-call result reaches the program, not the model, unless the outer
    // run_code prints it; touching it would only cost a spawn. Counted as `ptc`
    // so the unstamped bytes are visible instead of silently missing.
    if (exec.parent !== undefined) {
      options.onSkipped?.(exec, 'ptc')
      return undefined
    }

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
    const pattern = patternOf(exec.arguments)

    let compressed: HookOutput | null = null
    if (decision.compress && !result.isError && text !== undefined) {
      const shape = pickShape(path, text)
      // A file-reading or search call is left alone unless the caller opted in:
      // the host already bounds those results, and rtk's cap would truncate
      // source the caller asked for exactly. JSON and lockfiles stay — rtk's
      // read shape is where their summary actually pays off.
      const fileShaped = command === undefined && (path !== undefined || pattern !== undefined)
      const inScope = !fileShaped || config.compressFileTools || shape === 'read'
      const verb = command === undefined ? undefined : verbOf(command)
      const threshold =
        verb === undefined
          ? config.compressThresholdBytes
          : (config.compressThresholdByFamily[verb] ?? config.compressThresholdBytes)
      const worthIt =
        inScope && text.length >= threshold && text.length <= config.maxPayloadBytes && !ALREADY_MARKED.test(text)
      if (worthIt) {
        const started = Date.now()
        const cwd = options.cwdOf?.(exec)
        compressed = await roundTrip({
          binary,
          shape,
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
        const elapsed = Date.now() - started
        // Price both texts instead of the byte delta: a compression that drops
        // ASCII while keeping CJK saves fewer tokens than its byte count suggests.
        const savedTokens = estimateSavedTokens(text, compressed?.text ?? text)
        options.onCompressed?.(exec, text.length, compressed?.text.length ?? text.length, savedTokens, elapsed)
        options.log?.(
          `compress ${exec.name}: ${String(text.length)} -> ${String(compressed?.text.length ?? 0)} B in ${String(elapsed)} ms`,
        )
      } else if (!inScope) {
        options.onSkipped?.(exec, 'scope')
      } else if (text.length < threshold) {
        options.onSkipped?.(exec, 'size')
      } else if (text.length > config.maxPayloadBytes) {
        options.onSkipped?.(exec, 'payload')
      } else if (ALREADY_MARKED.test(text)) {
        options.onSkipped?.(exec, 'marked')
      }
    }

    const body = compressed?.text ?? text
    const notes: string[] = []
    // The annotation names a ~130-character absolute path in 'full' style; on a
    // short result it costs more than the rewrite saved, so it is only added
    // once the body is large enough to make it noise. Non-text results have no
    // comparable size — keep the signal there.
    if (
      wantsAnnotation &&
      rewrite !== undefined &&
      (body === undefined || body.length >= config.annotateMinBytes)
    ) {
      if (rewrite.fallback === true) {
        notes.push(`[rtk] fell back: ${rewrite.from}`)
      } else {
        // Short style names the bare `rtk …` proposal; the absolute path costs
        // ~130 characters per annotated result and is already in /rtk status.
        const named = config.annotateStyle === 'full' ? rewrite.to : (rewrite.proposal ?? rewrite.to)
        notes.push(`[rtk] ran: ${named}`)
      }
    }
    // rtk's own note (converted Read output) travels first: the model must see
    // it before it considers the body authoritative.
    if (compressed?.note !== undefined) notes.push(`[rtk] ${compressed.note}`)
    if (compressed !== null && text !== undefined && config.spillOriginal !== 'off') {
      const offeredRecall = compressed.text.includes('rtk recall')
      const hint = await options.spillOf?.(exec, text, offeredRecall)
      if (hint !== undefined) notes.push(hint)
    }
    if (notes.length === 0 && compressed === null) return undefined

    // Unreadable content (images, mixed blocks): prepend the notes as their own
    // block rather than pretending the rest is text.
    if (body === undefined) {
      return notes.length === 0 ? undefined : [{ type: 'text', text: notes.join('\n') }, ...content]
    }

    return [{ type: 'text', text: notes.length === 0 ? body : `${notes.join('\n')}\n${body}` }]
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
      ) =>
        | { readonly from: string; readonly to: string; readonly proposal?: string; readonly fallback?: boolean }
        | undefined,
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
