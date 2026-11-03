# Compatibility ledger

What this plugin has actually been checked against, with the evidence for each row. A row is added or refreshed before every release (see `docs/reference.md` § 6 for the behaviour matrix and `README.md` for install).

## Verified hosts

| Host (`@deepseek-ai/dsh`) | rtk | Checked on | Evidence | Notes |
|---|---|---|---|---|
| `0.2.1-rc.5` | `1.1.0` | 2026-11-03 | `pnpm typecheck`; `pnpm test` (12 files, 145 tests); `check-manifest`; `check-docs`; maintainer smoke on Windows 11 (`/rtk status`, rewrite, compression, recall) | 0.2.0 target. Clean-profile tarball install is re-run before the release |
| `0.2.1-rc.3` / `rc.4` | `1.1.0` | 2026-11-01 | M0 headless findings: rtk exit codes 0/1/2/3, `hook claude` round trip, sandbox behaviour | 0.1.x line, historical |

## Ranges declared in `package.json`

| Field | Range | Meaning |
|---|---|---|
| `engines.dsh` | `>=0.2.0-0 <0.3.0` | Host line the plugin loads on |
| `@deepseek-ai/dsh-tools` (peer) | `>=0.1.2-rc.1 <0.3.0` (prerelease branches) | Tool runtime contract (`ToolDefinition.execute`, pre/post-execute) |
| `@deepseek-ai/cordis` (peer) | `^4.0.2` | Plugin/context runtime |

## How to check a host

```sh
node scripts/verify-host.mjs                 # detect the installed host
node scripts/verify-host.mjs --host-version 0.2.1-rc.5
node scripts/verify-host.mjs --self-test      # exercise the range matcher
```

The script reads `package.json`, checks `engines.dsh` and every `@deepseek-ai/dsh*` peer range against the host version, prints one ledger row, and exits non-zero on a mismatch.

## What "verified" means

- **Unit / contract**: the repository gate (`typecheck`, `vitest`, `check-manifest`, `check-docs`) passes on that commit.
- **Runtime smoke**: the maintainer installed the packed tarball into a clean profile, restarted the host, and ran `/rtk status`, `/rtk doctor`, one rewritten command and one compressed result.
- **Not claimed**: every surface combination (all platforms × sandbox modes × co-installed plugins). The behaviour matrix in `docs/reference.md` § 6 states the limits.
