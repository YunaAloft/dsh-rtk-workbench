import { describe, expect, it } from 'vitest'
import { createCompressLayer } from '../src/compress-layer'
import type { Config } from '../src/config'

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    rtkPath: '',
    rtkSource: 'auto',
    timeoutMs: 2000,
    coldStartTimeoutMs: 8000,
    rewriteEnabled: true,
    rewriteFallback: 'retry',
    rewriteSandboxGuard: 'auto',
    rewriteSemanticGuard: 'enforce',
    shellTools: ['bash', 'pwsh'],
    rewriteTools: ['bash', 'ops_bash', 'pwsh'],
    rewriteExcludeCommands: ['cat', 'type', 'bat', 'less', 'more', 'head', 'tail'],
    compressEnabled: true,
    compressTools: [],
    excludeTools: [],
    compressThresholdBytes: 2048,
    maxPayloadBytes: 2 * 1024 * 1024,
    compressFileTools: false,
    compressThresholdByFamily: {},
    spillOriginal: 'auto',
    maxSpillBytes: 1024 * 1024,
    statsPersist: 'off',
    awarenessEnabled: true,
    uiPill: { get: () => true },
    denyEnabled: false,
    pipelineMode: 'auto',
    annotateRewrites: true,
    annotateStyle: 'short',
    rewriteCacheTtlMs: 600000,
    discoverShellTools: true,
    annotateMinBytes: 500,
    ...overrides,
  }
}

async function annotate(config: Config): Promise<string | undefined> {
  const layer = createCompressLayer({ binary: 'rtk', timeoutMs: 50, env: {}, config })
  const result = { isError: false, content: [{ type: 'text', text: 'x'.repeat(4096) }] } as never
  const next = async (): Promise<never> => ({ kind: 'accept' }) as never
  const decision = (await layer.listener(
    { name: 'bash', arguments: { command: 'git status' } } as never,
    result,
    next,
    () => ({ from: 'git status', to: "'C:/tools/rtk.exe' git status", proposal: 'rtk git status' }),
  )) as { content?: { text?: string }[] }
  return decision.content?.[0]?.text
}

describe('rewrite annotation style', () => {
  it('names the bare rtk command in short style', async () => {
    const text = await annotate(baseConfig({ annotateStyle: 'short' }))
    expect(text?.startsWith('[rtk] ran: rtk git status\n')).toBe(true)
  })

  it('keeps the resolved binary path in full style', async () => {
    const text = await annotate(baseConfig({ annotateStyle: 'full' }))
    expect(text?.startsWith("[rtk] ran: 'C:/tools/rtk.exe' git status\n")).toBe(true)
  })
})
