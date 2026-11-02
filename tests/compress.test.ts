import { describe, expect, it, vi } from 'vitest'
import { createCompressLayer, type CompressLayerOptions } from '../src/compress-layer'
import type { Config } from '../src/config'
import { extractHookOutput } from '../src/rtk/compress'

/** Minimal Config with the documented defaults. */
function baseConfig(overrides: Partial<Config> = {}): Config {
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
    rewriteExcludeCommands: ['cat', 'type', 'bat', 'less', 'more', 'head', 'tail'],
    compressEnabled: true,
    compressTools: ['*'],
    excludeTools: [],
    compressThresholdBytes: 2048,
    maxPayloadBytes: 2 * 1024 * 1024,
    compressFileTools: false,
    compressThresholdByFamily: { pytest: 512, cargo: 512, git: 512 },
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
    ...overrides,
  }
}

/** Fake round trip: records the call and returns a compressed body. */
function fakeRoundTrip(body = 'compressed', note?: string) {
  return vi.fn(async () => ({ text: body, ...(note === undefined ? {} : { note }) }))
}

type LayerOptions = Partial<CompressLayerOptions>

function makeLayer(config: Config, options: LayerOptions = {}) {
  return createCompressLayer({
    binary: 'rtk',
    timeoutMs: 50,
    env: {},
    config,
    ...options,
  })
}

/** Run one result through the listener. */
async function runOnce(
  layer: ReturnType<typeof createCompressLayer>,
  exec: unknown,
  text: string,
  rewrite?: { from: string; to: string; fallback?: boolean },
) {
  const result = { isError: false, content: [{ type: 'text', text }] } as never
  const next = async (): Promise<never> => ({ kind: 'accept' }) as never
  const decision = (await layer.listener(exec as never, result, next, () => rewrite)) as {
    content?: { type: string; text?: string }[]
  }
  return decision.content?.[0]?.text
}

describe('extractHookOutput', () => {
  it('returns the text and the additionalContext note', () => {
    const response = JSON.stringify({
      hookSpecificOutput: {
        updatedToolOutput: { file: { content: 'converted' } },
        additionalContext: 'RTK compressed this Read output',
      },
    })
    expect(extractHookOutput('read', response)).toEqual({
      text: 'converted',
      note: 'RTK compressed this Read output',
    })
  })

  it('omits the note when rtk did not send one', () => {
    const response = JSON.stringify({ hookSpecificOutput: { updatedToolOutput: { stdout: 'x', stderr: '' } } })
    expect(extractHookOutput('bash', response)).toEqual({ text: 'x' })
  })

  it('rejects malformed responses', () => {
    expect(extractHookOutput('bash', 'not json')).toBeNull()
    expect(extractHookOutput('bash', JSON.stringify({ hookSpecificOutput: {} }))).toBeNull()
  })
})

describe('compression scope', () => {
  it('leaves file-reading calls alone unless the caller opts in', async () => {
    const compress = fakeRoundTrip()
    const layer = makeLayer(baseConfig(), { compress })
    await runOnce(layer, { name: 'read', arguments: { file_path: '/w/a.ts' } }, 'x'.repeat(8000))
    expect(compress).not.toHaveBeenCalled()

    const optedIn = fakeRoundTrip()
    const layer2 = makeLayer(baseConfig({ compressFileTools: true }), { compress: optedIn })
    await runOnce(layer2, { name: 'read', arguments: { file_path: '/w/a.ts' } }, 'x'.repeat(8000))
    expect(optedIn).toHaveBeenCalledTimes(1)
  })

  it('leaves search calls alone as well', async () => {
    const compress = fakeRoundTrip()
    const layer = makeLayer(baseConfig(), { compress })
    await runOnce(layer, { name: 'grep', arguments: { pattern: 'TODO' } }, 'match\n'.repeat(2000))
    expect(compress).not.toHaveBeenCalled()
  })

  it('still compresses JSON and lockfiles through the read shape', async () => {
    const compress = fakeRoundTrip('{}')
    const layer = makeLayer(baseConfig(), { compress })
    await runOnce(layer, { name: 'read', arguments: { file_path: '/w/package-lock.json' } }, '{}'.repeat(2000))
    expect(compress).toHaveBeenCalledTimes(1)
  })

  it('uses the per-verb threshold for small noisy outputs', async () => {
    const compress = fakeRoundTrip('PASS')
    const layer = makeLayer(baseConfig(), { compress })
    // 600 bytes is below the global threshold but above pytest's.
    await runOnce(layer, { name: 'bash', arguments: { command: 'pytest -q' } }, 'line\n'.repeat(120))
    expect(compress).toHaveBeenCalledTimes(1)

    const defaultThreshold = fakeRoundTrip('x')
    const layer2 = makeLayer(baseConfig(), { compress: defaultThreshold })
    await runOnce(layer2, { name: 'bash', arguments: { command: 'node build.js' } }, 'line\n'.repeat(120))
    expect(defaultThreshold).not.toHaveBeenCalled()
  })
})

describe('compression notes and spill', () => {
  it('prepends the additionalContext note ahead of the compressed body', async () => {
    const layer = makeLayer(baseConfig(), {
      compress: fakeRoundTrip('toon', 'RTK compressed this Read output'),
    })
    const text = await runOnce(layer, { name: 'read', arguments: { file_path: '/w/a.json' } }, '{}'.repeat(2000))
    expect(text?.startsWith('[rtk] RTK compressed this Read output\n')).toBe(true)
  })

  it('appends the spill hint when the original is saved elsewhere', async () => {
    const spillOf = vi.fn(async () => '[rtk] original saved: /tmp/x.txt — use read')
    const layer = makeLayer(baseConfig(), { compress: fakeRoundTrip('short'), spillOf })
    const text = await runOnce(layer, { name: 'bash', arguments: { command: 'cargo test' } }, 'line\n'.repeat(2000))
    expect(spillOf).toHaveBeenCalledWith(expect.anything(), 'line\n'.repeat(2000), false)
    expect(text).toContain('[rtk] original saved: /tmp/x.txt')
    expect(text?.endsWith('\nshort')).toBe(true)
  })

  it('does not spill when the setting is off', async () => {
    const spillOf = vi.fn(async () => 'hint')
    const layer = makeLayer(baseConfig({ spillOriginal: 'off' }), { compress: fakeRoundTrip('short'), spillOf })
    await runOnce(layer, { name: 'bash', arguments: { command: 'cargo test' } }, 'line\n'.repeat(2000))
    expect(spillOf).not.toHaveBeenCalled()
  })

  it('annotates a fallback as fell back, never as ran', async () => {
    const layer = makeLayer(baseConfig({ compressTools: [] }))
    const text = await runOnce(layer, { name: 'bash', arguments: { command: 'ls -la' } }, 'x'.repeat(4096), {
      from: 'ls -la',
      to: 'rtk ls -la',
      fallback: true,
    })
    expect(text?.startsWith('[rtk] fell back: ls -la\n')).toBe(true)
  })
})
