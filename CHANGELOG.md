# Changelog

All notable changes to `dsh-rtk-workbench`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] — unreleased

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
