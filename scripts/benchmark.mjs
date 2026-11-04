#!/usr/bin/env node
/**
 * Reproducible benchmark: what the plugin's two paths actually save.
 *
 * Builds a deterministic fixture repository, runs each case twice — once raw,
 * once through the same code path the plugin uses — and prints a Markdown table
 * ready to paste into the README.
 *
 *   rewrite path   command  →  `rtk <command>` (run, capture stdout)
 *   compress path  output   →  `rtk hook claude` with a synthetic PostToolUse event
 *
 * Token figures are an ESTIMATE (bytes / 4) and labelled as such: no tokenizer is
 * bundled, and the fixtures are ASCII-heavy English/code.
 *
 * Usage: node scripts/benchmark.mjs [--rtk <binary>] [--json]
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { estimateTokens } from './tokens.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const rtkFlag = argv.indexOf('--rtk')
const RTK = rtkFlag === -1 ? 'rtk' : argv[rtkFlag + 1]
const asJson = argv.includes('--json')

/** Environment the plugin uses: its own pipeline, the user's tee/DB. */
const pluginPipeline = join(ROOT, 'vendor', '.bench-pipeline')
mkdirSync(pluginPipeline, { recursive: true })
writeFileSync(
  join(pluginPipeline, 'pipeline.toml'),
  'schema_version = 1\n\n[pipeline]\nname    = "dsh-rtk-workbench-bench"\nextends = "rtk:posthook"\n',
)
const ENV = { ...process.env, RTK_CONFIG_DIR: pluginPipeline }

/** Run a command in the fixture and return stdout bytes. */
function run(cwd, command, args = []) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: ENV })
  if (result.status !== 0 && result.stdout === '') {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr ?? ''}`)
  }
  return result.stdout
}

/** Bytes of a string as UTF-8. */
const bytes = (text) => Buffer.byteLength(text, 'utf8')

/** Whitespace-insensitive comparison so "same information" is auditable. */
const normalize = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * Compress one output through the plugin's PostToolUse path.
 *
 * @returns the condensed text, or the input when rtk declined to change it.
 */
function compress(text, { toolName = 'Bash', path = '' } = {}) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { command: path === '' ? 'npm test' : 'cat x', file_path: path },
    tool_response:
      toolName === 'Read'
        ? { type: 'text', file: { content: text, numLines: 1, totalLines: 1 } }
        : { stdout: text, stderr: '', interrupted: false },
  })
  const result = spawnSync(RTK, ['hook', 'claude'], { input: payload, encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0 || result.stdout.trim() === '') return text
  try {
    const parsed = JSON.parse(result.stdout)
    const updated = parsed?.hookSpecificOutput?.updatedToolOutput
    if (updated === undefined) return text
    return toolName === 'Read' ? (updated?.file?.content ?? text) : (updated?.stdout ?? text)
  } catch {
    return text
  }
}

/** Build the deterministic fixture repository. */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rtk-bench-'))
  const git = (args) => run(dir, 'git', ['-c', 'user.email=bench@example.com', '-c', 'user.name=Bench', ...args])
  run(dir, 'git', ['init', '-q'])
  git(['config', 'core.autocrlf', 'false'])

  // 40 commits with realistic bodies, then a dirty worktree.
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(join(dir, 'app.ts'), `export const version = ${String(index)}\n${'// padding\n'.repeat(20)}`)
    git(['add', '-A'])
    git(['commit', '-qm', `feat(core): add handler ${String(index)} for the streaming pipeline`])
  }
  writeFileSync(join(dir, 'app.ts'), `export const version = 999\n${'// padding\n'.repeat(20)}`)
  writeFileSync(join(dir, 'new-file.txt'), 'hello\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(join(dir, 'src', `module-${String(index)}.ts`), `// TODO: wire this up\nexport const n = ${String(index)}\n`)
  }

  // 300 TODO lines so `grep` has something worth grouping.
  const todoLines = []
  for (let index = 0; index < 300; index += 1) todoLines.push(`// TODO(${String(index)}): replace the placeholder branch`)
  writeFileSync(join(dir, 'src', 'todo-heavy.ts'), todoLines.join('\n') + '\n')
  // A 200-line file the diff case rewrites wholesale.
  const beforeLines = []
  for (let index = 0; index < 200; index += 1) beforeLines.push(`export function fn${String(index)}(value: number): number { return value + ${String(index)} }`)
  writeFileSync(join(dir, 'src', 'changing.ts'), beforeLines.join('\n') + '\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'feat(src): add generated modules'])
  const afterLines = beforeLines.map((line, index) => (index % 2 === 0 ? line.replace('return value +', 'return value -') : line))
  writeFileSync(join(dir, 'src', 'changing.ts'), afterLines.join('\n') + '\n')


  // A noisy test log: 2 000 lines of pytest-style output.
  const testLog = []
  for (let index = 0; index < 2000; index += 1) {
    testLog.push(index % 25 === 0 ? `FAILED tests/test_${String(index)}.py::test_case - AssertionError` : `tests/test_${String(index)}.py::test_case PASSED [  ${String(index % 100)}%]`)
  }
  testLog.push('==================== 80 failed, 1920 passed in 42.13s ====================')
  writeFileSync(join(dir, 'run-tests.log'), testLog.join('\n') + '\n')

  // A repetitive application log.
  const appLog = []
  for (let index = 0; index < 5000; index += 1) {
    appLog.push(`2026-11-02T01:00:${String(index % 60).padStart(2, '0')}Z INFO request ${String(index)} handled in ${String(index % 40)}ms`)
  }
  writeFileSync(join(dir, 'app.log'), appLog.join('\n') + '\n')

  // A lockfile-shaped JSON document.
  const packages = {}
  for (let index = 0; index < 300; index += 1) {
    packages[`node_modules/pkg-${String(index)}`] = {
      version: `1.${String(index)}.0`,
      resolved: `https://registry.npmjs.org/pkg-${String(index)}/-/pkg-${String(index)}-1.${String(index)}.0.tgz`,
      integrity: `sha512-${'A'.repeat(86)}`,
    }
  }
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }, null, 2))
  return dir
}

const fixture = buildFixture()
const rows = []

/** Record one case: same command, raw vs rtk-rewritten. */
function rewriteCase(label, command, args) {
  try {
    const raw = run(fixture, command, args)
    const rewritten = run(fixture, RTK, [command, ...args])
    rows.push({
      label,
      path: 'rewrite',
      before: bytes(raw),
      after: bytes(rewritten),
      beforeTokens: estimateTokens(raw),
      afterTokens: estimateTokens(rewritten),
      same: normalize(raw).includes(normalize(rewritten).slice(0, 40)),
    })
  } catch (error) {
    // A command the platform does not ship (for example `ls`/`grep` on Windows)
    // is reported as skipped instead of failing the whole benchmark.
    rows.push({ label, path: 'rewrite', skipped: error instanceof Error ? error.message.split('\n')[0] : String(error) })
  }
}

/** Record one case: same output, raw vs PostToolUse compression. */
function compressCase(label, text, options) {
  const out = compress(text, options)
  rows.push({
    label,
    path: 'compress',
    before: bytes(text),
    after: bytes(out),
    beforeTokens: estimateTokens(text),
    afterTokens: estimateTokens(out),
    same: normalize(text) === normalize(out),
  })
}

rewriteCase('git status', 'git', ['status'])
rewriteCase('git log, 20 commits', 'git', ['log', '-n', '20'])
rewriteCase('git diff', 'git', ['diff'])
rewriteCase('ls -la', 'ls', ['-la'])
rewriteCase('grep -rn TODO src', 'grep', ['-rn', 'TODO', 'src'])

compressCase('pytest output, 2 001 lines', readFileSync(join(fixture, 'run-tests.log'), 'utf8'))
compressCase('application log, 5 000 lines', readFileSync(join(fixture, 'app.log'), 'utf8'))
compressCase('package-lock.json (read shape)', readFileSync(join(fixture, 'package-lock.json'), 'utf8'), {
  toolName: 'Read',
  path: 'package-lock.json',
})

const table = [
  '| Case | Path | Before | After | Saved | Est. tokens before → after |',
  '|---|---|---:|---:|---:|---:|',
  ...rows.map((row) => {
    if (row.skipped !== undefined) {
      return `| ${row.label} | ${row.path} | — | — | skipped | — |`
    }
    const delta = row.before === 0 ? 0 : (1 - row.after / row.before) * 100
    const sign = delta >= 0 ? '−' : '+'
    const amount = Math.abs(delta).toFixed(1)
    return `| ${row.label} | ${row.path} | ${row.before.toLocaleString('en-US')} B | ${row.after.toLocaleString('en-US')} B | ${sign}${amount} % | ${row.beforeTokens.toLocaleString('en-US')} → ${row.afterTokens.toLocaleString('en-US')} |`
  }),
].join('\n')

const measured = rows.filter((row) => row.skipped === undefined)

if (asJson) {
  console.log(JSON.stringify({ platform: process.platform, rtk: RTK, rows }, null, 2))
} else {
  const totalBefore = measured.reduce((sum, row) => sum + row.before, 0)
  const totalAfter = measured.reduce((sum, row) => sum + row.after, 0)
  const tokensBefore = measured.reduce((sum, row) => sum + row.beforeTokens, 0)
  const tokensAfter = measured.reduce((sum, row) => sum + row.afterTokens, 0)
  console.log(table)
  console.log('')
  console.log(
    `Total: ${totalBefore.toLocaleString('en-US')} B → ${totalAfter.toLocaleString('en-US')} B (−${((1 - totalAfter / totalBefore) * 100).toFixed(1)} %), est. tokens ${tokensBefore.toLocaleString('en-US')} → ${tokensAfter.toLocaleString('en-US')}`,
  )
  console.log('')
  console.log(
    `Token figures use the plugin's own estimate (ASCII / 4, CJK x 0.6), not a provider tokenizer; skipped rows name a command this platform does not ship. Re-run with \`--json\` for raw numbers.`,
  )
}

rmSync(fixture, { recursive: true, force: true })
rmSync(pluginPipeline, { recursive: true, force: true })
