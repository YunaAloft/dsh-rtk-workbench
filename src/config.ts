import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin configuration. Every tunable lives here (never hardcoded): the
 * harness validates this Schema at load time and fails loud on invalid
 * values, and each key can be overridden from `cordis.patch.yml` without
 * editing code.
 *
 * Defaults come from the M0 measurements in `memos/plans/m0-findings.md`:
 * one `rtk hook claude` call costs p50 ≈ 96 ms and one `rtk rewrite` p50 ≈
 * 206 ms, which is what sets the compression threshold and the rewrite
 * filtering rules.
 */
export interface Config {
  /** Explicit rtk binary path. Empty = `RTK_BIN`/`DSH_RTK_BIN`/bundled/PATH. */
  rtkPath: string
  /** `auto` uses the bundled binary when present; `path` always resolves through PATH. */
  rtkSource: 'auto' | 'path'
  /** Per-invocation timeout in milliseconds. Timeout = no rewrite / no compression. */
  timeoutMs: number
  /**
   * Budget for the first rtk call in a fresh host process. The platform may
   * scan the unsigned bundled binary on first spawn (measured 2.7–5.8 s), which
   * the ordinary per-call budget would misread as "rtk is unusable".
   */
  coldStartTimeoutMs: number
  /** Master switch for command rewriting. */
  rewriteEnabled: boolean
  /**
   * Retry the original command when rtk itself failed to run the rewritten one
   * (spawn denied, binary unusable). A retry can duplicate a partially executed
   * command, so it is limited to rtk's own failure signature.
   */
  rewriteFallback: 'retry' | 'off'
  /**
   * Windows only: skip rewriting while the session's sandbox confines child
   * processes (`workspace-write` / `read-only`), where `rtk <cmd>` cannot spawn
   * the real command. `off` forces rewriting even there.
   */
  rewriteSandboxGuard: 'auto' | 'off'
  /**
   * Verify that rtk's proposal still runs the original command before executing
   * it. `enforce` rejects proposals that dropped tokens (rtk 1.1.0 maps
   * `next build` to `rtk next`); `off` trusts rtk's stdout as-is.
   */
  rewriteSemanticGuard: 'enforce' | 'off'
  /** Tool names treated as shells for detection (official names first). */
  shellTools: string[]
  /** Tool names eligible for rewriting (POSIX shells only by default). */
  rewriteTools: string[]
  /** Command words never rewritten: their rtk replacement filters nothing. */
  rewriteExcludeCommands: string[]
  /** Master switch for tool-output compression. */
  compressEnabled: boolean
  /** Tool names eligible for compression; `*` = every tool's text result. */
  compressTools: string[]
  /** Tool names never touched, regardless of other lists. */
  excludeTools: string[]
  /** Skip compression below this many bytes (one spawn costs ~96 ms). */
  compressThresholdBytes: number
  /** Skip compression above this many bytes (rtk caps hook stdin at 64 MiB). */
  maxPayloadBytes: number
  /**
   * Compress file-reading tool results too. Off by default: the host's own
   * file/search tools already bound their output, and rtk's cap would truncate
   * source code that the caller asked for exactly.
   */
  compressFileTools: boolean
  /**
   * Per-verb compression thresholds. Small-but-noisy family outputs (test
   * runners, builds, docker) are worth a spawn below the global threshold;
   * unlisted verbs fall back to `compressThresholdBytes`.
   */
  compressThresholdByFamily: Record<string, number>
  /**
   * Spill the original text through the host's spill store when rtk's own
   * recall path is unreachable (sandboxed shell, broken store). `auto` also
   * spills when rtk's compressed text carries no recall hint.
   */
  spillOriginal: 'auto' | 'always' | 'off'
  /** Skip spilling texts above this many bytes. */
  maxSpillBytes: number
  /** Inject the rtk awareness section into the system prompt. */
  awarenessEnabled: boolean
  /** Honour rtk's `deny` verdict from the PreToolUse bridge. Default off. */
  denyEnabled: boolean
  /**
   * `auto` keeps the plugin-owned pipeline unless the user's own rtk pipeline
   * already compresses (then it is respected); `plugin-owned` always injects
   * through `RTK_CONFIG_DIR`; `user` never injects.
   */
  pipelineMode: 'auto' | 'plugin-owned' | 'user'
  /** Prepend a `[rtk] ran: …` line so the model sees the executed command. */
  annotateRewrites: boolean
  /**
   * `short` names the bare rtk command (`rtk git status`); `full` includes the
   * absolute binary path. Short is the default: the path costs ~130 characters
   * per annotated result and the binary is already in `/rtk status`.
   */
  annotateStyle: 'short' | 'full'
  /** Body size below which the annotation is skipped (it would cost more than it explains). */
  annotateMinBytes: number
  /**
   * How long one `rtk rewrite` answer is reused. 0 disables the cache; the
   * decision only depends on the command, the shell dialect and the cwd.
   */
  rewriteCacheTtlMs: number
  /** Treat shell-like tool names as shells even when no config list names them. */
  discoverShellTools: boolean
}

export const Config: Schema<Config> = Schema.object({
  rtkPath: Schema.string()
    .default('')
    .description('Explicit path to the rtk binary. Empty = RTK_BIN / DSH_RTK_BIN / bundled / PATH.'),
  rtkSource: Schema.union(['auto', 'path'])
    .default('auto')
    .description('auto prefers the binary shipped with this package; path always resolves through PATH.'),
  timeoutMs: Schema.number()
    .default(2000)
    .description('Per-invocation timeout in milliseconds; a timeout means no rewrite and no compression.'),
  coldStartTimeoutMs: Schema.number()
    .default(8000)
    .description(
      'Budget for the first call in a fresh host process; the platform may scan the bundled binary on first spawn.',
    ),
  rewriteEnabled: Schema.boolean().default(true).description('Master switch for command rewriting.'),
  rewriteFallback: Schema.union(['retry', 'off'])
    .default('retry')
    .description(
      'Retry the original command when rtk itself failed to run the rewritten one. Limited to rtk failure signatures.',
    ),
  rewriteSandboxGuard: Schema.union(['auto', 'off'])
    .default('auto')
    .description(
      'Windows only: skip rewriting while the session sandbox confines child processes (workspace-write / read-only).',
    ),
  rewriteSemanticGuard: Schema.union(['enforce', 'off'])
    .default('enforce')
    .description(
      'Verify that rtk’s proposal still runs the original command; rejects argument-dropping rewrites (rtk 1.1.0 turns `next build` into `rtk next`).',
    ),
  shellTools: Schema.array(Schema.string())
    .default(['bash', 'pwsh'])
    .description('Tool names treated as shells for detection (official DSH names first).'),
  rewriteExcludeCommands: Schema.array(Schema.string())
    .default(['cat', 'type', 'bat', 'less', 'more', 'head', 'tail'])
    .description(
      'Command words never rewritten. rtk maps these to `rtk read`, which filters nothing for logs and makes rtk skip its own posthook for that call, so the output never gets compressed either. Leaving them raw is strictly better.',
    ),
  rewriteTools: Schema.array(Schema.string())
    .default(['bash', 'ops_bash', 'pwsh'])
    .description(
      'Tool names eligible for rewriting. Windows users drive pwsh; rtk still rewrites the external programs called there ' +
        '(git, cargo, docker, ls) and defers on cmdlets, which a local pre-filter skips.',
    ),
  compressEnabled: Schema.boolean().default(true).description('Master switch for tool-output compression.'),
  compressTools: Schema.array(Schema.string())
    .default(['*'])
    .description("Tool names eligible for compression; '*' means every tool's text result."),
  excludeTools: Schema.array(Schema.string())
    .default([])
    .description('Tool names never touched, regardless of other lists.'),
  compressThresholdBytes: Schema.number()
    .default(2048)
    .description('Skip compression below this many bytes (one rtk spawn costs ~96 ms).'),
  maxPayloadBytes: Schema.number()
    .default(2 * 1024 * 1024)
    .description('Skip compression above this many bytes (rtk caps hook stdin at 64 MiB).'),
  compressFileTools: Schema.boolean()
    .default(false)
    .description('Compress file-reading tool results too (default: shell/MCP/web plus JSON and lockfiles only).'),
  compressThresholdByFamily: Schema.dict(Schema.number())
    .default({
      pytest: 512,
      cargo: 512,
      docker: 512,
      git: 512,
      npm: 512,
      pnpm: 512,
      yarn: 512,
      make: 512,
      go: 512,
      mvn: 512,
      gradle: 512,
    })
    .description('Per-verb compression thresholds; unlisted verbs use compressThresholdBytes.'),
  spillOriginal: Schema.union(['auto', 'always', 'off'])
    .default('auto')
    .description('Spill the original text when rtk recall is unreachable (auto), always, or never.'),
  maxSpillBytes: Schema.number()
    .default(1024 * 1024)
    .description('Skip spilling texts larger than this many bytes.'),
  awarenessEnabled: Schema.boolean().default(true).description('Inject the rtk awareness section into the system prompt.'),
  denyEnabled: Schema.boolean().default(false).description("Honour rtk's deny verdict. Off by default: cc-safety-net already covers command blocking."),
  pipelineMode: Schema.union(['auto', 'plugin-owned', 'user'])
    .default('auto')
    .description(
      'auto respects an existing user pipeline and otherwise injects the plugin pipeline; plugin-owned always injects; user never injects.',
    ),
  annotateMinBytes: Schema.number()
    .default(500)
    .description(
      'Skip the `[rtk] ran: …` annotation when the result is shorter than this. The annotation carries an absolute path, so on a tiny result it costs more than the rewrite saved.',
    ),
  annotateRewrites: Schema.boolean()
    .default(true)
    .description('Prepend `[rtk] ran: <command>` to the result so the executed command is visible.'),
  annotateStyle: Schema.union(['short', 'full'])
    .default('short')
    .description('short names the bare rtk command; full includes the absolute binary path (~130 extra characters).'),
  rewriteCacheTtlMs: Schema.number()
    .default(600_000)
    .description('Reuse one rtk rewrite answer for this many milliseconds; 0 disables the cache.'),
  discoverShellTools: Schema.boolean()
    .default(true)
    .description('Treat shell-like tool names (bash/pwsh/shell suffixes) as shells even when unlisted.'),
})
