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
    annotateMinBytes: 500,
  }
}

/** Handler wired to a fake registry; no rtk process is involved. */
function makeHandler(config: Config) {
  return createCommandHandler({
    ctx: { tools: { schemas: () => [{ name: 'bash' }, { name: 'pwsh' }, { name: 'some_tool' }] } } as never,
    config,
    binary: 'rtk',
    binarySource: 'path',
    pipeline: () => ({ mode: 'plugin-owned', dir: 'C:/tmp/pipeline', health: 'ok', trust: [] }),
    env: {},
    timeoutMs: 500,
    patched: () => ['bash'],
    skipped: () => new Map(),
    foreignTransforms: () => 0,
    capability: () => ({ state: 'ok', detail: 'test' }),
  })
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
})
