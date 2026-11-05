# Benchmark

What this plugin's two paths save on a deterministic fixture, and what those numbers do **not** prove.

## How to reproduce

```sh
node scripts/benchmark.mjs          # Markdown table
node scripts/benchmark.mjs --json   # raw rows
```

The script builds a throwaway fixture repository (40 commits, a dirty worktree, a 200-line rewrite, a 2 000-line test log, a 5 000-line application log and a 300-package lockfile), runs each case twice — once raw, once through the same code path the plugin uses — and prints the table below. Nothing touches your repository; the fixture lives in the system temp directory and is deleted afterwards.

## Environment of this run

| Item | Value |
|---|---|
| OS | Windows 11 |
| rtk | `1.1.0` |
| Plugin | `1.0.1` |
| Node | 24.22 |
| Pipeline | plugin-owned (`rtk:posthook`), injected through `RTK_CONFIG_DIR` |

## Results

| Case | Path | Before | After | Saved | Est. tokens before → after |
|---|---|---:|---:|---:|---:|
| `git status` | rewrite | 377 B | 47 B | −87.5 % | 95 → 12 |
| `git log -n 20` | rewrite | 3 578 B | 1 698 B | −52.5 % | 895 → 425 |
| `git diff` | rewrite | 20 511 B | 6 945 B | −66.1 % | 5 128 → 1 737 |
| `ls -la` | rewrite | — | — | skipped | — |
| `grep -rn TODO src` | rewrite | — | — | skipped | — |
| pytest output, 2 001 lines | compress | 89 505 B | 11 287 B | −87.4 % | 22 377 → 2 822 |
| application log, 5 000 lines | compress | 272 640 B | 13 633 B | −95.0 % | 68 160 → 3 409 |
| `package-lock.json` (read shape) | compress | 76 896 B | 4 654 B | −93.9 % | 19 224 → 1 164 |
| **Total** | | **463 507 B** | **38 264 B** | **−91.7 %** | **115 879 → 9 569** |

The two `skipped` rows are POSIX commands that Windows does not ship: `rtk ls` tries to spawn `ls` and rtk reports `program not found`. The skip is visible in the table instead of failing the run — a benchmark that silently drops cases would be worse than one that names them.

Re-running the script can move the totals by a byte or two, because rtk formats its own output. Treat the percentages as the stable figure and the byte counts as one run's sample.

## What the token column means

Tokens are estimated by the same function the plugin uses (`src/tokens.ts`): ASCII-dense text at four characters per token, CJK characters and full-width forms at 0.6 tokens each, rounded up.

**It is not a tokenizer.** The provider counts differently and the difference is largest on CJK-heavy or code-heavy text. `tests/tokens.test.ts` pins the formula on constructed samples; `tests/benchmark-tokens.test.ts` keeps this script's copy in sync with the plugin's. Neither can measure accuracy against a real tokenizer offline.

## What this benchmark is not

- **Not a model-request measurement.** It counts the bytes and estimated tokens of tool output, not what an actual request billed. The system prompt, conversation history, cached prefixes and the model's own output are out of scope.
- **Not a comparison against other plugins.** The `dsh-token-saver` / `billion-context` co-install runs describe a different layer (post-processing and conversation folding); comparing them here would mix measurements.
- **Not a distribution.** Each case is one deterministic run. Real workloads vary; treat the table as an upper bound on what the mechanism can do on this kind of output, not as an expected per-session saving.
- **Not reproducible across platforms for the skipped rows.** On Linux and macOS the two rewrite cases run; on Windows they are named as skipped above.

Measure your own workload by comparing `/rtk stats` before and after, or read the lifetime totals the plugin persists at `<DSH_HOME>/rtk-workbench/stats.json`.
