# Changelog

All notable changes to `dsh-rtk-workbench`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

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
- **Distribution only, not in the package:** the GitHub release asset now also carries `docs/`, `CHANGELOG.md` and `README.en.md` (it previously shipped a README whose relative links pointed at files the tarball did not contain), and the packaging script fails loudly when a staged path disappears. The npm tarball already contained them, so no package content changed and no new version was cut.

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
