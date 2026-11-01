#!/usr/bin/env node
/**
 * Platform smoke test for a bundled rtk binary.
 *
 * Proves the two things that only fail on a real machine: the binary executes on
 * this platform, and the hook contract this plugin depends on still answers.
 *
 * Usage: node scripts/smoke-rtk.mjs <path-to-rtk>
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const binary = process.argv[2]
if (binary === undefined || !existsSync(binary)) {
  console.error('usage: node scripts/smoke-rtk.mjs <path-to-rtk>')
  process.exit(2)
}

/** Run the binary and return its outcome. */
function run(args, input) {
  const result = spawnSync(binary, args, { encoding: 'utf8', input, timeout: 30_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

const version = run(['--version'])
if (version.error !== undefined || version.status !== 0) {
  console.error(`version check failed: ${version.error?.message ?? version.stderr.trim()}`)
  process.exit(1)
}
console.log(`version: ${version.stdout.trim()}`)

if (process.platform !== 'win32') {
  // A tarball packed on Windows records 0644; the plugin repairs it at resolution
  // time, and this check proves the repair is the only thing missing.
  const { chmodSync, statSync } = await import('node:fs')
  const mode = statSync(binary).mode & 0o777
  console.log(`mode: 0${mode.toString(8)}`)
  if ((mode & 0o100) === 0) chmodSync(binary, 0o755)
}

const payload = JSON.stringify({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'cat sample.log' },
  tool_response: { stdout: 'PASS test_0 ok\n'.repeat(200), stderr: '', interrupted: false },
})
const hook = run(['hook', 'claude'], payload)
if (hook.error !== undefined) {
  console.error(`hook spawn failed: ${hook.error.message}`)
  process.exit(1)
}
// Without a pipeline file rtk has no after_tool rules, so an empty stdout is the
// correct answer; the point is that the process ran and exited cleanly.
if (hook.status !== 0) {
  console.error(`hook exited ${String(hook.status)}: ${hook.stderr.trim()}`)
  process.exit(1)
}
console.log(`hook: exit 0, ${String(hook.stdout.trim().length)} bytes of output`)
console.log('smoke ok')
