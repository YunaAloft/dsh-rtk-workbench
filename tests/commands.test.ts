import { describe, expect, it } from 'vitest'
import { createCommandHandler } from '../src/commands'
import type { Config } from '../src/config'

/** Minimal Config with the documented defaults. */
function baseConfig(): Config {
  return {
    rtkPath: '',
    rtkSource: 'auto',
    timeoutMs: 2000,
    coldStartTimeoutMs: 8000,
    rewriteEnabled: true,
    rewriteFallback: 'retry',
    rewriteSandboxGuard: 'auto',
    shellTools: ['bash', 'pwsh'],
    rewriteTools: ['bash', 'ops_bash', 'pwsh'],
    rewriteExcludeCommands: ['cat'],
    compressEnabled: true,
    compressTools: ['*'],
    excludeTools: [],
    compressThresholdBytes: 2048,
    maxPayloadBytes: 2 * 1024 * 1024,
    compressFileTools: false,
    compressThresholdByFamily: { pytest: 512 },
    spillOriginal: 'auto',
    maxSpillBytes: 1024 * 1024,
    awarenessEnabled: true,
    denyEnabled: false,
    pipelineMode: 'plugin-owned',
    annotateRewrites: true,
    annotateStyle: 'short',
    rewriteCacheTtlMs: 600000,
    discoverShellTools: true,
    annotateMinBytes: 500,
  }
}

/** Deterministic rtk substitute: no process is spawned by the command tests. */
async function fakeRun(_binary: string, args: readonly string[]) {
  if (args[0] === '--version') return { code: 0, stdout: 'rtk 1.1.1\n', stderr: '' }
  if (args[0] === 'recall') return { code: 0, stdout: 'hash\tcommand\nabc123\tgit status\n', stderr: '' }
  if (args[0] === 'pipeline') return { code: 0, stdout: 'Pipeline: dsh-rtk-workbench\nInherits: rtk:posthook\n', stderr: '' }
  if (args[0] === 'methods') return { code: 0, stdout: 'methods\nterm\n', stderr: '' }
  if (args[0] === 'trust') return { code: 0, stdout: '', stderr: '' }
  return { code: 0, stdout: 'ok', stderr: '' }
}

/** Handler wired to a fake registry; no rtk process is involved. */
function makeHandler(config: Config, overrides: Record<string, unknown> = {}) {
  return createCommandHandler({
    ctx: { tools: { schemas: () => [{ name: 'bash' }, { name: 'pwsh' }, { name: 'some_tool' }] } } as never,
    config,
    binary: 'rtk',
    binarySource: 'path',
    run: fakeRun,
    pipeline: () => ({ mode: 'plugin-owned', dir: 'C:/tmp/pipeline', health: 'ok', trust: [] }),
    env: {},
    timeoutMs: 500,
    patched: () => ['bash'],
    skipped: () => new Map(),
    stats: () => ({
      lines: ['session    : 1 compressions'],
      report: 'session    : test',
      json: '{"session":"test"}',
      summary: { calls: 1, savedBytes: 100 },
    }),
    rewrites: () => ({ calls: 0, fallbacks: 0, learned: [] }),
    foreignTransforms: () => 0,
    capability: () => ({ state: 'ok', detail: 'test' }),
    ...overrides,
  } as never)
}

describe('/rtk command handler', () => {
  it('lists how each visible tool resolved', async () => {
    const outcome = await makeHandler(baseConfig()).handle({ rawInput: ' tools ', agent: {} })
    expect(outcome.kind).toBe('success')
    const text = outcome.kind === 'success' ? (outcome.text ?? '') : ''
    expect(text).toContain('bash')
    expect(text).toContain('rewrite + compress')
    expect(text).toContain('powershell')
    // The `*` wildcard is summarized on one line instead of listing every tool.
    expect(text).toContain("compress: every tool's text result")
    expect(text).toContain('patched:')
  })

  it('toggles a switch by mutating the live config', async () => {
    const config = baseConfig()
    const handler = makeHandler(config)
    expect(await handler.handle({ rawInput: 'off rewrite', agent: {} })).toEqual({
      kind: 'success',
      text: 'rewrite off',
    })
    expect(config.rewriteEnabled).toBe(false)
    expect(await handler.handle({ rawInput: 'on compress', agent: {} })).toEqual({
      kind: 'success',
      text: 'compress on',
    })
  })

  it('rejects an unknown toggle target', async () => {
    const outcome = await makeHandler(baseConfig()).handle({ rawInput: 'off everything', agent: {} })
    expect(outcome.kind).toBe('error')
  })

  it('falls back to help text for an unknown subcommand', async () => {
    const outcome = await makeHandler(baseConfig()).handle({ rawInput: 'nope', agent: {} })
    const text = outcome.kind === 'success' ? (outcome.text ?? '') : ''
    expect(text).toContain('/rtk <subcommand>')
  })

  it('appends the session summary to status', async () => {
    const outcome = await makeHandler(baseConfig()).handle({ rawInput: 'status', agent: { id: 's1' } })
    const text = outcome.kind === 'success' ? (outcome.text ?? '') : ''
    expect(text).toContain('session    : 1 compressions')
    expect(text).toContain('pipeline   : plugin-owned')
  })

  it('serves the session report and its JSON form', async () => {
    const handler = makeHandler(baseConfig())
    const report = await handler.handle({ rawInput: 'stats', agent: {} })
    expect(report.kind === 'success' ? report.text : '').toContain('session    : test')
    const json = await handler.handle({ rawInput: 'stats --json', agent: {} })
    expect(json.kind === 'success' ? json.text : '').toBe('{"session":"test"}')
  })

  it('warns when a broken pipeline produced no savings', async () => {
    const handler = makeHandler(baseConfig(), {
      pipeline: () => ({ mode: 'plugin-owned', dir: '', health: 'problems', detail: 'x', trust: [] }),
      stats: () => ({
        lines: [],
        report: '',
        json: '',
        summary: { calls: 6, savedBytes: 0 },
      }),
    })
    const outcome = await handler.handle({ rawInput: 'status', agent: {} })
    const text = outcome.kind === 'success' ? (outcome.text ?? '') : ''
    expect(text).toContain('the injected pipeline is not active')
  })
})
