# dsh-rtk-workbench reference (1.0.0)

Applies to DSH `0.2.2-rc.1`, rtk `1.1.0`, Node `^22.19.0 || >=24`. Restart `dsh web` after installing — a bundle change is not a page refresh.

## 1. Install and verify

```sh
dsh plugin --profile <profile> add dsh-rtk-workbench
```

After the restart:

```
/rtk status     # binary, source, pipeline health, switches, this session's savings
/rtk doctor     # deep check: version, pipeline, a real round trip, recall, trust
/rtk tools      # how each visible tool resolved (canonical / alias / explicit)
```

The `binary` line names the source: `bundled` (shipped with the package), `path` (`rtk` on PATH), or `config`/`env` (explicit override). Resolution order: `rtkPath` → `RTK_BIN` / `DSH_RTK_BIN` → bundled platform package → `rtk` on PATH.

## 2. Commands

| Command | What it does |
|---|---|
| `/rtk status` | Binary and source, probe result, version, recall store, pipeline mode and health, rewrite/compress/awareness switches, patched tools, this session's savings and skip reasons |
| `/rtk stats [--json]` | Full session report: compressions, bytes in/out, time, per tool, rewrites and fallbacks, learned verbs, error counters |
| `/rtk tools` | Tool resolution detail: `canonical`, `alias` (e.g. `ops_bash`), `explicit` |
| `/rtk explain <cmd>` | Why a command would (not) be rewritten: the local pre-filter plus rtk's own `rtk hook check` decision |
| `/rtk doctor` | Item-by-item self-check: binary, `pipeline show/validate/status`, `methods`, `trust`, a `hook claude` round trip, recall |
| `/rtk gain` | Forwards to `rtk gain` — rtk-wide totals, not this session |
| `/rtk recall <hash>` | Restores elided text in the host process; use it when the model shell is sandboxed away from rtk's store |
| `/rtk on\|off <rewrite\|compress\|ui>` | Session toggle; `/rtk off compress` isolates a competing result transformer, `/rtk off ui` hides the web pill |
| `/rtk help [topic]` | Command list; `topic` is `pipeline`, `sandbox`, `recovery` or `config` |

**Web pill and overlay.** In the web GUI the plugin renders one pill in the composer dock — `saved 12.4k token · ↓81%` — with the compression and rewrite counts beside it and the guard count only after a rejection. Three colours: normal, warning (rtk unusable, or the injected pipeline fell back), grey (compression switched off). Clicking it opens an overlay with health, this session, lifetime, by-tool rows, skip reasons, the last three events, a self-check button and a diagnostics copy action. The pill is hidden until the first status document arrives and can be turned off with `uiPill: false` or `/rtk off ui`.

The browser half reads one read-only route the host half mounts on the profile's webserver: `GET /api/rtk-workbench/status` (counts and enums only — no command text, output or paths) and `POST /api/rtk-workbench/doctor` (runs the same diagnostics as `/rtk doctor`). A headless profile has no webserver, so the route is simply absent there.

Example `/rtk status` summary:

```
session    : 12 compressions 48.2 KB → 9.1 KB (-81%, ~9.8k tok saved), 1.4 s, 3 rewrites
skipped    : size 9, scope 4, ptc 3
learned    : rewrite suppressed for ls
lifetime   : 2 831 compressions, ~1.2M tok saved since 2026-11-05
```

## 3. Configuration

Every key can be overridden from `cordis.patch.yml`; values are validated at load time.

| Key | Default | Meaning |
|---|---|---|
| `rtkPath` | `''` | Explicit binary; empty = `RTK_BIN` / `DSH_RTK_BIN` / bundled / PATH |
| `rtkSource` | `auto` | `auto` prefers the bundled binary; `path` resolves through PATH |
| `timeoutMs` | `2000` | Steady-state per-call budget; a timeout means no rewrite and no compression |
| `coldStartTimeoutMs` | `8000` | First-call budget; scanning an unsigned binary takes 2.7–5.8 s on first spawn |
| `rewriteEnabled` | `true` | Master switch for rewriting |
| `rewriteFallback` | `retry` | Replay the original command when rtk itself failed (rtk failure signatures only) |
| `rewriteSandboxGuard` | `auto` | Windows + confined sandbox skips rewrites (see `help sandbox`); `off` forces them |
| `rewriteSemanticGuard` | `enforce` | Verify the proposal still runs the original command; `off` trusts rtk's stdout. `next build` → `rtk next` is accepted (rtk injects `build`); `python -m pytest` → `rtk pytest` is refused |
| `shellTools` | `['bash','pwsh']` | Names treated as shells for detection |
| `rewriteTools` | `['bash','ops_bash','pwsh']` | Tools eligible for rewriting; `discoverShellTools` also accepts shell-like names |
| `rewriteExcludeCommands` | `['cat','type','bat','less','more','head','tail']` | Command words never rewritten |
| `compressEnabled` | `true` | Master switch for compression |
| `compressTools` | `['*']` | Tools eligible for compression; `*` = every text result |
| `excludeTools` | `[]` | Tools never touched |
| `compressThresholdBytes` | `2048` | Global compression threshold |
| `maxPayloadBytes` | `2097152` | Skip above this (rtk caps hook stdin at 64 MiB) |
| `compressFileTools` | `false` | Also compress file-reading tools (off: the host already bounds them and rtk's cap would truncate requested source) |
| `compressThresholdByFamily` | see below | Per-verb threshold overrides, e.g. `pytest: 512` |
| `spillOriginal` | `auto` | Spill the pre-compression text to session-private storage: `auto` (when rtk recall is unreachable) / `always` / `off` |
| `maxSpillBytes` | `1048576` | Do not spill above this size |
| `statsPersist` | `aggregate` | Persist counts (never text) to `<DSH_HOME>/rtk-workbench/stats.json` so totals survive a restart; `off` keeps them in memory |
| `uiPill` | `true` | Show the savings pill and its overlay in the web GUI; `/rtk off ui` hides it for the session |
| `awarenessEnabled` | `true` | Inject the prompt section (only after the probe proves rtk works) |
| `denyEnabled` | `false` | Honour rtk's deny verdict; DSH has no host permission rules, so this stays off |
| `pipelineMode` | `auto` | `auto` respects an existing user pipeline; `plugin-owned` always injects; `user` never injects |
| `annotateRewrites` | `true` | Add the `[rtk] ran:` line |
| `annotateStyle` | `short` | `short` names the bare `rtk <cmd>`; `full` includes the absolute binary path |
| `annotateMinBytes` | `500` | Skip the annotation below this body size |
| `rewriteCacheTtlMs` | `600000` | Reuse one rewrite answer per `cwd + command`; 0 disables |
| `discoverShellTools` | `true` | Treat shell-like tool names as shells even when unlisted |

`compressThresholdByFamily` defaults: `pytest`, `cargo`, `docker`, `git`, `npm`, `pnpm`, `yarn`, `make`, `go`, `mvn`, `gradle` at 512 B; anything else uses `compressThresholdBytes`.

`RTK_DB_PATH` and `RTK_TEE_DIR` are deliberately **not** overridden: the model runs `rtk recall` through the ordinary shell, and redirecting the tee/DB would make recovery impossible.

## 4. What the model sees

- `[rtk] ran: rtk git status` — the command ran in rtk form (`annotateStyle: full` adds the binary path).
- `[rtk] fell back: git status` — rtk could not run; the original command was replayed, and that verb is suppressed for the session.
- `[rtk] <note>` — rtk's own warning, e.g. that a Read output was format-converted and must not be used as an `Edit` `old_string`.
- `[rtk] original saved: <path> — …` — the original text is in session-private spill storage; read or grep it directly.
- `rtk recall <hash>` at the end — rtk's own recovery pointer.
- One static prompt section, registered only after the probe succeeds.

## 5. Recovery

1. `[rtk] original saved: <path>` → read that path (works inside a sandbox).
2. `rtk recall <hash>` → run it in a normal shell, or ask the user to run `/rtk recall <hash>` (the host process is not sandboxed).
3. Neither present and the result looks incomplete → `/rtk doctor` for recall and pipeline state.

## 6. Compatibility

| Component | Version |
|---|---|
| DeepSeek Harness | `0.2.2-rc.1` (target; `dshTarget` in `package.json`) |
| rtk | `1.1.0` (bundled; `dshRtkVersion`) |
| Node | `^22.19.0 || >=24` |
| Plugin | `1.0.0` |

The matrix describes the plugin's *observable* behaviour. "skipped" always means
"refused before spawning", never "tried and failed silently".

| Environment | Rewrite | Compress | Recover | Notes |
|---|---|---|---|---|
| Linux x64/arm64 native | full | full | full | Preferred: bash native, rtk native, store writable |
| macOS x64/arm64 native | full | full | full | Same as Linux; the unit suite runs on macOS in CI, and both macOS binaries are smoked by the `binary` jobs |
| Windows + `danger-full-access` | full | full | full | Verified on the maintainer's machine; `ls`/`grep` rewrites work |
| Windows + `workspace-write` | **skipped** | full | spill | The host denies rtk its child process (`os error 5`); `rewriteSandboxGuard: off` forces and will fail |
| Windows + `read-only` | **skipped** | full | spill | Same denial; nothing is writable |
| Windows + `wsl.exe` as the shell backend | unsupported | partial | spill | Windows `rtk.exe` is invisible inside the distro; set `rewriteTools: []` |
| DSH inside WSL (Linux host) | full | full | full | Treated as Linux |

`spill` means the original text is saved through the host's spill store and named in the result when rtk's own recall is unreachable.

**Coexistence.** Shell tools republished under another name (e.g. an `ops_` prefix) are recognised through the alias table and `discoverShellTools`; rewriting calls the tool's own `execute`, so the owning plugin's sandboxing still applies. The compression listener always awaits `next()` first, then transforms the content the downstream decision carries; when another transformer replaced it, `/rtk status` reports `observed: another result transformer changed N result(s)` without naming the plugin. If another plugin keeps replacing our `execute` wrapper, the plugin stops re-wrapping after three attempts and reports it under `skipped`. Results already replaced by the host spill policy carry a marker and are not compressed again. `RTK_CONFIG_DIR` is only set for the plugin's own spawns (and only in `plugin-owned`/`auto`); the user's `config.toml` and `filters.toml` are never overridden.

**Co-installation matrix.** "Cannot" means both plugins claim the same host seam and only one can be active.

| Co-installed plugin | Result | What to do |
|---|---|---|
| Shell-executor replacements (`dsh-rtk`, `dsh-bash-rtk`, `dsh-pwsh-rtk-rewrite`) | Cannot coexist: each replaces `ctx.shell`, which the host allows once per context | Pick one; disable the others |
| `dsh-rtk-bridge` (also wraps `execute`) | Both try to own the wrapper; one stops re-wrapping after three attempts and reports `skipped` | Prefer one rewriter; check `/rtk status` |
| `dsh-router-ext-rtk` (short-circuits `tools/execute`) | Its rewrite runs first; this plugin sees an `rtk` prefix, skips rewriting, and still compresses the result | Safe, single rewrite |
| `dsh-token-saver` (trims in `tools/post-execute`) | Safe: its trimming markers are recognised and this layer leaves the text alone | No double trimming |
| `billion-context` (folds old dialogue, ACP markers) | Safe: ACP-marked content is skipped | None |

**Semantic guard.** Before executing a proposal, the plugin checks that every rewritten segment still carries the original command: a plain prefix (`git status` → `rtk git status`), a `gradle` → `gradlew` mapping, a `next build [args]` → `rtk next [args]` mapping (rtk's `next` always injects the `build` subcommand, so no argument is lost), or a `read` mapping whose path and line window survive. A proposal that dropped a token — rtk 1.1.0 turns `python -m pytest` into `rtk pytest` — is refused, the original command runs, and the call is counted under `guard` in `/rtk stats`. `/rtk explain <command>` shows the verdict and names the mapping that proved equivalence. Rejected rewrites still get post-execute compression on their output.

**Token figures.** Savings are estimated from both texts at compression time: ASCII-dense characters price at 0.25 tokens each, CJK characters and full-width forms at 0.6. The byte delta is never used as a proxy, because mixed Chinese and English output has no single bytes-per-token ratio. Every surface — `/rtk stats`, `--json`, the pill, the overlay, the benchmark and the README — reads the same function; `tests/tokens.test.ts` pins it and `tests/benchmark-tokens.test.ts` keeps the benchmark script's copy in sync. It is an estimate, not provider billing.

**Version policy.** Platform subpackages share the main package's version and record the bundled rtk version; a DSH upgrade re-runs the compatibility check against the new tag before release. The reference rtk source is the release tag matching the bundled binary (`release-v1.1.0`), never `develop`.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `rtk is not usable` | Missing binary or timeout | Check the `probe` line; allow the cold start; set `rtkPath` |
| Compression never fires | Below threshold, skipped by scope, or pipeline fell back | `/rtk stats` for `skipped`; `/rtk doctor` for `validate`/`pl status` |
| `compress : on` but zero savings | Injected pipeline failed and rtk fell back to `rtk:default` | The `pipeline` line and the `compress` warning; `/rtk doctor` |
| A command fails unexpectedly | rtk could not spawn the real command | The sandbox guard already skips these; turn `rewriteSandboxGuard` back on |
| `rtk recall` reports a store error | Sandboxed shell | Ask the user for `/rtk recall`, or read the spill path |
| One verb keeps failing | The environment cannot run it | It is tripped; see the `learned` line |
| A rewritten command looks like a different command | rtk's proposal dropped an argument (`python -m pytest` → `rtk pytest`) | The semantic guard runs the original; see `guard` in `/rtk stats` and `/rtk explain <cmd>` |
| Results look changed by someone else | Another result transformer | The `observed` line; compare with `/rtk off compress` |
| The pill never appears | Headless profile (no webserver), the route failed to mount, or the UI switch is off | `/rtk status` still works; check `uiPill` and `/rtk on ui` |
| `platform pkg: none for …` in `/rtk doctor` | rtk publishes no build for this platform (e.g. Windows arm64) | Point `rtkPath` at an rtk on PATH or inside WSL, or use a different plugin |

## 8. Known limitations (host differences, not missing work)

- DSH has no PreToolUse command-rewrite hook; a plugin can only wrap tool execution.
- DSH has no `RTK.md` include; a static prompt section replaces it.
- `rtk session` / `discover` / `learn` read Claude Code history and have no DSH counterpart.
- rtk's deny rules read `~/.claude` permissions; DSH has no such rules, so deny stays off.
- A Windows confined sandbox cannot let rtk spawn the real command, so rewriting is unavailable there (compression still works).
- `fish` wrapping, `rtk init` claiming DSH, and the Windows-with-WSL backend are unsupported.
- The pill and overlay exist only in the web GUI; headless and CLI surfaces use `/rtk status`.
- Token figures are an estimate with a fixed heuristic; no provider tokenizer is available offline.

## 9. Design notes

- The plugin wraps `ToolDefinition.execute` rather than re-dispatching, so registry signal fusion and accounting are preserved.
- It treats rtk as a pure function (`rtk rewrite` in/out strings, `rtk hook claude` in/out JSON); DSH has no hook to install.
- The pipeline is plugin-owned via `RTK_CONFIG_DIR`, and `auto` removes that override when the user's pipeline already compresses.
- A failed rewrite is replayed as the original command and that verb is suppressed, so a broken environment degrades to a normal command.
- Compression scope follows the call shape (file/search results stay untouched) and the original is spilled when rtk recall is unreachable.
- Session counters live in memory: they answer "what did this plugin do in this session", not what rtk's global database says. Aggregates (counts only) are also appended to `<DSH_HOME>/rtk-workbench/stats.json` so the totals survive a restart.
- Savings are priced from the before/after texts at compression time and accumulated in tokens; the ledger stores counts, never command text or output.
- The browser half writes nothing: it reads one read-only route, renders, and disposes its poll and styles with the plugin lifecycle.
- A Windows confined sandbox skips rewrites up front because rtk cannot spawn the wrapped command there; compression is unaffected.
