import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Structural view of `ctx.spillStore` (`@deepseek-ai/dsh-spill`). */
interface SpillStoreLike {
  saveText(input: {
    readonly owner: { readonly sessionId: string }
    readonly source: {
      readonly kind: 'tool'
      readonly toolName: string
      readonly callId: string
      readonly label: string
    }
    readonly suggestedName: string
    readonly content: string
  }): Promise<{ readonly locator: string; readonly bytes: number; readonly retrievalHint: string }>
}

/**
 * Save the pre-compression text through the host's spill store.
 *
 * Why: rtk's compressed output points at `rtk recall <hash>`, but a sandboxed
 * shell can read files while it cannot write rtk's database, so `rtk recall`
 * fails exactly where the model needs it. The spill store writes a
 * session-private file the model can `read`/`grep` through its ordinary tools,
 * so recovery works with no host command and no path into the user's project.
 *
 * Best effort: a missing store, a tool call without an agent, an oversized
 * body, or a storage failure all return `undefined` and leave rtk's own hint.
 *
 * @param ctx - plugin context (may or may not expose the spill service).
 * @param exec - the call whose result is being compressed.
 * @param text - the original, pre-compression text.
 * @param maxBytes - do not spill bodies above this size.
 * @returns the model-facing hint line, or `undefined`.
 */
export async function spillOriginal(
  ctx: Context,
  exec: Pick<ToolExecution, 'agent' | 'name' | 'callId'>,
  text: string,
  maxBytes: number,
): Promise<string | undefined> {
  if (text.length === 0 || text.length > maxBytes) return undefined
  try {
    const store = ctx.get('spillStore') as SpillStoreLike | undefined
    const agent = exec.agent as { id?: unknown } | undefined
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
    if (store === undefined || sessionId === undefined) return undefined
    const reference = await store.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName: exec.name, callId: String(exec.callId), label: 'rtk-original' },
      suggestedName: `${exec.name}-original.txt`,
      content: text,
    })
    const hint = reference.retrievalHint.trim()
    return `[rtk] original saved: ${reference.locator}${hint === '' ? '' : ` — ${hint}`}`
  } catch {
    return undefined
  }
}
