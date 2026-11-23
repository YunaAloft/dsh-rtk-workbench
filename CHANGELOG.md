# Changelog

All notable changes to `dsh-rtk-workbench`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `/rtk gain` appends a note about rtk 1.2.1's known rtk-wide bias (shadow decisions count stderr; the headline caps only input tokens). The note is removed once #5111 and #5125 ship.
- `/rtk doctor` reports `disabled   : RTK_DISABLED=1 (automatic rewrite skipped)` when the switch is set.
- The overlay's "this session" block explains zero or low numbers in four states (compressed / rewrites only / too small / nothing yet) and shows skip reasons as their own row. The help drawer gains a "Why it shows 0 / very little" block.

### Changed

- Baseline: bundled rtk `1.2.1`; DSH `0.2.2-rc.5` type baseline and matching dev lockfile.
- The pill shows `已改写 N 次 / 本会话没有可压缩的输出` when a session rewrote but compressed nothing.
- The rewrite pre-filter skips `command`/`builtin`/`exec`; the guard accepts transparent `env`/`timeout`/`time`/`nohup`/`nice`/`uv run`/`nocorrect`/`noglob` wrappers and assembles partially accepted compound commands (the `command` segment stays verbatim, the git segment is rewritten).
- rtk processes spawned by the plugin default to `RTK_TELEMETRY_DISABLED=1` (telemetry off). rtk in the user's own shell is unaffected.
- `RTK_DISABLED=1` disables automatic rewrites; the compression layer still tries, and manual `/rtk` commands are unaffected.
- Detail preview images re-rendered (option 3: captions +18px, card bottom +18px, divider and footer +18px; zh/en).

## [1.2.0] — 2026-11-15

Makes the overlay explain itself, gives the plugin page a real preview image, and stops counting an rtk no-op as a compression. This update also fixes the stale-stylesheet bug from #17 and avoids a false "unusable" flash on a slow first probe.

### Added

- The overlay now has separate **Diagnostics** and **Feedback & export** blocks at the bottom, after health, this session, lifetime, by-tool rows and recent events. Diagnostics records when the self-check ran, starts collapsed, expands to the full text, and can be cleared or copied with a `Checked at …` first line; a running check shows `正在自检…` with a short hint, and the completed or failed result opens automatically. Feedback copies the status JSON, explains what it is for, and opens a self-contained help drawer through the `点击此处可查看如何解读这些数据 →` button (reading the self-check, the status JSON, and common failures). The health block ends with a `查看诊断 ↓` button that scrolls to the diagnostics block.
- The first capability probe is an initializing state: it gets a 15-second budget and one automatic retry after a timeout, showing a neutral `RTK 初始化中` instead of a false yellow `RTK 不可用`. Only a final failure turns the pill yellow; a successful retry goes straight to green.
- The plugin detail page now shows a single feature preview per UI language. `locale/*.json` points `meta.detail` at `docs/DETAIL.md` / `docs/DETAIL.zh.md`, each referencing a 1280×480 (2× of 640×240) PNG. The README fallback, which dropped raw HTML images and showed Chinese text in the English UI, is no longer used for the detail page.
- A repository-owned `scripts/check-preview.mjs` runs in CI and verifies the PNG pair, both DETAIL documents, `meta.detail`, and `package.json#files`; `smoke-pack` verifies the four files in both tarball shapes and that the README banner is not shipped.

### Changed

- Status/session copy now uses `RTK` for the product and `rtk` for commands and binaries. The unreachable status route and the failed binary probe get distinct first lines: `RTK 状态不可达` / `RTK unreachable` versus `RTK 不可用` / `RTK unusable`.
- The diagnostics action is now `复制状态 JSON` / `Copy status JSON`, with a usage hint below it and a visible `复制失败` / `Copy failed` state when the clipboard rejects the write.
- Skip reasons are displayed with labels and counts (`太小 10 次 · 文件/搜索 6 次 · 试压不划算 4 次`; `too small 10× …`) while the JSON and `/rtk stats` keep the raw keys. The session block explains a zero saving when rewrites happened but compression had nothing left to do. The feedback block also shows the full current session id with a copy action for bug reports.
- The pill separator matches the host's readings: 6px on each side and `separator-primary`. The `/rtk` ghost hint is now the short `help · status · on/off <switch>`.

### Fixed

- A session with no stats record no longer renders as `nothing yet` with the health row claiming it matches the current session. The overlay now distinguishes a missing session (`no rtk record for this session yet`) from a record with zero compressions, and explains that the lifetime total covers all sessions (#19).
- An in-place plugin update refreshed the new JavaScript but kept the old `<style>` element, leaving new markup with stale CSS: the icon rendered at its intrinsic 300×150 and the pill lost its frame. The client now replaces the existing stylesheet's contents instead of returning early (#17).
- An rtk invocation that returned nothing useful no longer increments `compressions` while leaving `in == out` and `savedTokens == 0`. Only a real `ok` result is counted; a normal `noop` is recorded under `skipped`, and spawn/timeout/exit/payload/parse failures are recorded under `errors`.
- A cold first probe no longer paints the pill yellow while a freshly installed Windows binary is still being scanned. The probe keeps a neutral initializing state, uses a 15-second budget and retries a timeout once; only the final failure is reported as `RTK 不可用`.

## [1.1.2] — 2026-11-14

Fixes the mobile composer-dock layout reported in #15, matches the pill to the host's dock readings, keeps the pill switch across restarts (#14), and keeps this conversation's counters after a restart.

### Fixed

- The pill no longer refuses to shrink. It gets `min-width: 0` and an ellipsis on the savings segment, so a cramped dock compresses the pill instead of squeezing the host's own readings down to their icons. Narrow viewports converge in three steps: ≤767px drops the compression/rewrite counts, ≤480px keeps only `saved X tok`, and ≤360px collapses the savings state to icon plus dot while state words (ready / unusable / off) stay readable and unshrunk.
- The leading icon now follows the theme. The SVG rectangles had no `fill`, so they rendered black in the dark theme; they inherit `currentColor` instead.
- `/rtk off ui` and `/rtk on ui` now persist. `uiPill` is a volatile config field, so the host commits the new value into the running plugin without remounting it, and the command writes the profile config instead of only mutating memory. Restarting the host keeps the choice. When there is no profile entry to write to (headless embedding) or a higher config layer shadows the field, the command reports why rather than pretending the switch was saved.
- This conversation's counters survive a host restart. Session records (compressions, bytes, savings, rewrites, by-tool rows, recent events) are written to `stats.json` v2 alongside the lifetime totals: the newest 512 sessions are kept by last activity and anything older than 60 days is dropped. Only counts, tool names and timestamps are stored. `statsPersist: off` disables both layers.

### Changed

- The pill now matches the host's dock readings: no border and no background, a 14px leading icon with the state dot, the headline in `label-secondary` and the detail in `label-tertiary`, with a hover background instead of a permanent frame.
- Rewrites are counted per session as well as per process, so the pill's `N compressions · M rewrites` line stays meaningful after a restart.
- The token unit in the pill, the overlay rows and the overlay footnote is now `tok`, matching the host's own readings (`86.3M tok`).

## [1.1.1] — 2026-11-13

Fixes the status-route admission race that could leave the savings pill invisible on desktop and web profiles, and keeps an unreachable route visible in the UI.

### Fixed

- The status route now waits for the host's `client-connection` service instead of capturing it during `apply`. `client-connection` provides the service after its asynchronous browser auth store is ready, so the previous eager read could leave the route permanently fail-closed: `/api/rtk-workbench/status` answered 401 for every request, the savings pill never received its first document, and both desktop and web profiles showed no pill. Admission now resolves the service per request, keeps `requestRejection`'s `this` bound, and `/rtk doctor` reports `authenticated` once the service is available.
- When the first status fetch fails, the client now renders a grey `rtk unavailable` pill with the error in its overlay instead of disappearing. A fail-closed or unreachable route is visible instead of looking like the plugin never loaded.

## [1.1.0] — 2026-11-12

Bundles rtk 1.2.0 and hardens the rewrite pre-filter.

### Changed

- Bundled rtk upgraded from 1.1.0 to 1.2.0. The upstream release fixes segment rewriting (#4132), routes commands without a filter through `swap` (#4685), corrects `gain` timing accounting (#4677, #3943) and folds `git ls-tree` by directory (#1816). The semantic-guard corpus was re-checked against the 1.2.0 source: `next build [args]` → `rtk next [args]` and the argument-dropping `python -m pytest` → `rtk pytest` mapping are unchanged, so both the accepted and refused cases still hold.

### Fixed

- `rtk rewrite` is now called with `--` when the command starts with a dash. Without it, `rtk rewrite -h` is parsed by rtk's own clap layer, prints help and exits 0 — and the help text then looks like an allowed rewrite. `--` ends option parsing so the command is always data.
- The recursion pre-filter now recognises an already-rewritten command through the shapes shells actually produce: environment prefixes (`FOO=1 rtk …`), quoted command words (`"rtk" …`), absolute/Windows paths, `.exe` suffixes and different case. Previously each of those paid an unnecessary `rtk rewrite` spawn before returning the command unchanged.

## [1.0.2] — 2026-11-12

The status surface closes two data-plane gaps reported after 1.0.1: the read-only route had no host authentication, and the pill kept the previous session's numbers until that session ran a tool.

### Security

- `GET /api/rtk-workbench/status` and `POST /api/rtk-workbench/doctor` now sit behind the host's client-connection admission fence (Host header fence against DNS rebinding, Origin/`sec-fetch-site` same-origin checks, and the signed browser cookie): unauthenticated requests get 401, cross-site or untrusted Hosts get 403. The payload has always been counts and enums only — no command text, output or paths — but before this release any local process that could reach the webserver could read it. If the `connection` service is missing the route fails closed (401 for everything) instead of serving unauthenticated, and `/rtk doctor` reports the route's exposure in a new `web route` line.

### Fixed

- The savings pill follows the current session. It previously showed the most recently active session's numbers until that session ran a tool: the status route accepts `?session=<id>`, the browser half learns its session id from the session-scoped composer slot and refetches immediately on a switch, and while the returned snapshot key does not match the current session the pill and the overlay render "loading" instead of stale numbers. The overlay's health section names both keys (shortened) when they differ.

## [1.0.1] — 2026-11-06

A copy fix in the web UI, plus the documentation refresh that 1.0.0's npm page could not show.

### Fixed

- The savings pill reads `saved 12.4k token · ↓81%` instead of `-81%`. A leading minus next to "saved … token" reads as a loss, and the ASCII hyphen did not match the typographic minus the documents use. The overlay labels the same figure as a reduction (`降幅 81%`) instead of parenthesising it, and the recent-event rows use the same arrow.

### Changed

- npm's rendered README now matches the repository: the tightened 97-line README, the language-specific header (the Chinese one states `自带 rtk`), and the expanded acronym moved out of the tagline into the paragraph that explains rtk. npm snapshots the README at publish time, so this could not reach the 1.0.0 page without a release.

## [1.0.0] — 2026-11-05

The savings become visible: one token estimate everywhere, a cross-restart ledger, and a web pill that shows what this session saved without running a command. 1.0.0 freezes the configuration keys and the command surface.

### Added

- **Web pill and overlay.** A composer-dock pill reads `saved 12.4k token · −81%`, turns warning-coloured when rtk is unusable or the injected pipeline fell back, and opens a details overlay (health, this session, lifetime, by tool, skip reasons, recent events, self-check, copy diagnostics). Read-only: nothing writes configuration. `uiPill: true` by default; `/rtk off ui` hides it.
- **Read-only status route.** The host half serves `GET /api/rtk-workbench/status` and `POST /api/rtk-workbench/doctor` from the profile's webserver. The payload carries counts and enums only — no command text, no output, no paths.
- **Token estimate.** Savings are priced from both texts at compression time (ASCII-dense text ÷ 4, CJK characters × 0.6) instead of the byte delta, because mixed Chinese and English output has no single bytes-per-token ratio. `/rtk stats`, `--json`, the pill, the overlay and every published number share one function.
- **Cross-restart ledger.** Counts (never text) are persisted to `<DSH_HOME>/rtk-workbench/stats.json` with atomic, debounced writes; `statsPersist: 'aggregate' | 'off'`. `/rtk status` and `/rtk stats` gained `lifetime` lines.
- **PTC accounting.** `run_code` sub-calls are counted under the `ptc` skip reason instead of disappearing, so uncovered bytes are visible.
- **Platform guidance.** `/rtk doctor` names the platform package it expects, or says rtk publishes no build for this platform and offers `rtkPath`/PATH as the way out.
- **Output-side guardrail.** The awareness section now states that condensation applies to tool output only: reports keep their numbers, caveats and warnings.
- **Benchmark and packaging smoke.** `docs/benchmark.{md,zh.md}` from a deterministic fixture, `scripts/smoke-pack.mjs`, and a CI job that packs the artifact and checks the file list, both halves and the bundled binary.

### Changed

- The semantic guard accepts `next build [args]` → `rtk next [args]`: rtk's `next` command always injects the `build` subcommand, so the dropped word is not a dropped argument. Proposals that do drop one are still refused, and `/rtk explain` names the mapping that proved equivalence.
- README defaults to Chinese (`README.en.md` keeps English) and was trimmed from 149 to 108 lines; the earlier per-case table moved into the benchmark document.
- `dshTarget` is `0.2.2-rc.1`. The verified-host row was added to `docs/compatibility.md`.
- Configuration keys and the `/rtk` command surface are frozen from this release: further keys are additive only.
- **Distribution only, not in the package:** the GitHub release asset now also carries `docs/`, `CHANGELOG.md` and `README.en.md` (it previously shipped a README whose relative buttons pointed at files the tarball did not contain), and the packaging script fails loudly when a staged path disappears. The npm tarball already contained them, so no package content changed and no new version was cut.

## [0.2.0] — 2026-11-03

The production-time compression loop: rewrite what rtk can rewrite, compress the rest through a plugin-owned rtk pipeline, make the original recoverable, and tell the model what happened.

### Added

- **Output compression through a real rtk pipeline.** The plugin injects an `rtk:posthook` pipeline via `RTK_CONFIG_DIR` and calls `rtk hook claude` from `tools/post-execute`. Without the injection rtk's `rtk:default` has no after-tool rules and the hook returns nothing.
- **Recovery.** `rtk recall` stays available; when the sandbox cannot reach rtk's store the original text is spilled to session-private storage and named in the result (`[rtk] original saved: …`).
- **Awareness section.** One static prompt section explains `[rtk] ran:`, `[rtk] fell back:`, elisions and recovery; it is registered only after the start-up probe proves rtk is usable.
- **Session visibility.** `/rtk status`, `/rtk stats [--json]`, `/rtk tools`, `/rtk explain`, `/rtk doctor`, `/rtk gain`, `/rtk recall <hash>` and per-session `on`/`off`.
- **Semantic guard (default `enforce`).** A proposal is executed only when every rewritten segment still runs the original command: a plain `rtk` prefix, a `gradle` → `gradlew` mapping, or a `read` mapping whose path and line window survive. Proposals that dropped arguments (rtk 1.1.0 turns `next build` into `rtk next`, `python -m pytest` into `rtk pytest`) fall back to the original command and are counted under `guard`.
- **Compatibility ledger** (`docs/compatibility.md`) plus `scripts/verify-host.mjs` (range self-test and a printable ledger row) and a `verify:host` script.

### Changed

- Rewriting runs through the patched `ToolDefinition.execute`, not through `tools/pre-execute`; the listener only gates and installs the wrapper, so registry signal fusion and `bodyInvoked` accounting stay intact.
- The semantic guard is configurable (`rewriteSemanticGuard: 'enforce' | 'off'`) for a future rtk whose legitimate transforms the guard cannot prove.
- Documentation now states that the recorded tool call keeps the original command on every rewrite route, and that the plugin compensates with the `[rtk] ran:` annotation and the awareness section.
- Co-installation is documented as a matrix: shell-executor replacements cannot coexist, `dsh-rtk-bridge` competes for the execute wrapper, and `dsh-token-saver` / `dsh-router-ext-rtk` / `billion-context` can coexist.
- Results already trimmed by `dsh-token-saver` are recognised by its markers and skipped by this layer.
- Packaging publishes five platform packages carrying rtk `1.1.0`, GitHub fat tarballs, and the bilingual reference plus compatibility docs.

### Fixed

- A rewrite rtk could not run is replayed as the original command and that verb is suppressed for the session.
- Windows confined sandboxes skip rewriting up front (rtk cannot spawn the real command) while compression keeps working.
- A pipeline that fell back to `rtk:default` is visible in `/rtk status` and `/rtk doctor` instead of silently removing compression.
- Cold start no longer loses the first command to the steady-state timeout.
- Read-output conversions pass rtk's `additionalContext` note through, so the model does not use converted text as an `Edit` anchor.

### Security

- The semantic guard closes an argument-dropping path in rtk's rewrite output (see Added).
- rtk's deny verdict remains available but off by default; DSH has no host permission rules, so it is not advertised as a security layer.

## [0.1.1] — 2026-11-02

- Packaging fixes: platform packages point at this repository; the bundled rtk binary carries its dual license.
- README describes rtk's adapters accurately.

## [0.1.0] — 2026-11-01

- First release: command rewriting through `rtk rewrite`, prompt section, bundled rtk, `/rtk` status commands.
