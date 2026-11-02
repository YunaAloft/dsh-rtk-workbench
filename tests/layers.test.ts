import { describe, expect, it } from 'vitest'
import { createCompressLayer } from '../src/compress-layer'
import type { Config } from '../src/config'
import { createRewriteLayer } from '../src/rewrite-layer'

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
    compressThresholdByFamily: { pytest: 512 },
    spillOriginal: 'auto',
    maxSpillBytes: 1024 * 1024,
    awarenessEnabled: true,
    denyEnabled: false,
    pipelineMode: 'plugin-owned',
    annotateRewrites: true,
    annotateMinBytes: 500,
    ...overrides,
  }
}

/** Fake tool registry: one definition object per name per scope key. */
function fakeCtx(definitions: Map<string, { execute: (...args: never[]) => unknown; [key: string]: unknown }>) {
  return {
    tools: {
      get: (name: string) => definitions.get(name),
    },
  } as never
}

function makeDefinition(name: string, impl: (...args: never[]) => unknown) {
  return { name, execute: impl } as {
    name: string
    execute: (...args: never[]) => unknown
    [key: string]: unknown
  }
}

/** Call a wrapped definition without fighting the never[] signature. */
function invoke(definition: { execute: unknown }, args: unknown): Promise<unknown> {
  const fn = definition.execute as (a: unknown, e: unknown) => Promise<unknown>
  return fn(args, {})
}

describe('rewrite layer patching', () => {
  it('wraps a writable definition and passes unroutable commands straight through', async () => {
    let called = 0
    const definition = makeDefinition('bash', async () => {
      called += 1
      return 'ok'
    })
    const ctx = fakeCtx(new Map([['bash', definition]]))
    const layer = createRewriteLayer({ ctx, binary: 'rtk', timeoutMs: 100, env: {} })
    layer.ensurePatched('bash', undefined)
    expect(definition.execute).not.toBe(undefined)
    // `cd /tmp` is a builtin-only command: the wrapper must not spawn rtk.
    const result = await invoke(definition, { command: 'cd /tmp' })
    expect(result).toBe('ok')
    expect(called).toBe(1)
    expect(layer.patchedList()).toContain('bash')
    layer.dispose()
  })

  it('records a skip when the definition is not writable', () => {
    const definition = makeDefinition('bash', async () => 'x')
    Object.defineProperty(definition, 'execute', { value: definition.execute, writable: false })
    const ctx = fakeCtx(new Map([['bash', definition]]))
    const layer = createRewriteLayer({ ctx, binary: 'rtk', timeoutMs: 100, env: {} })
    layer.ensurePatched('bash', undefined)
    expect([...layer.skippedList().keys()]).toContain('bash')
    layer.dispose()
  })

  it('re-wraps when another plugin replaces execute underneath us', async () => {
    const definition = makeDefinition('bash', async () => 'first')
    const ctx = fakeCtx(new Map([['bash', definition]]))
    const layer = createRewriteLayer({ ctx, binary: 'rtk', timeoutMs: 100, env: {} })
    layer.ensurePatched('bash', undefined)
    const ours = definition.execute
    definition.execute = async () => 'second'
    layer.ensurePatched('bash', undefined)
    expect(definition.execute).not.toBe(ours)
    const value = await invoke(definition, { command: 'cd /tmp' })
    expect(value).toBe('second')
    layer.dispose()
  })

  it('restores the original execute on dispose', async () => {
    const original = async () => 'orig'
    const definition = makeDefinition('bash', original)
    const ctx = fakeCtx(new Map([['bash', definition]]))
    const layer = createRewriteLayer({ ctx, binary: 'rtk', timeoutMs: 100, env: {} })
    layer.ensurePatched('bash', undefined)
    expect(definition.execute).not.toBe(original)
    layer.dispose()
    expect(definition.execute).toBe(original)
  })
})

describe('compression layer', () => {
  const exec = { name: 'bash', arguments: { command: 'cat big.log' } } as never

  function runLayer(config: Config, rewrite?: { from: string; to: string }) {
    const layer = createCompressLayer({ binary: 'rtk', timeoutMs: 50, env: {}, config })
    const result = { isError: false, content: [{ type: 'text', text: 'x'.repeat(4096) }] } as never
    const next = async (): Promise<never> => ({ kind: 'accept' }) as never
    const rewriteOf = () => rewrite
    return { layer, result, next, rewriteOf }
  }

  it('keeps the original body when it only annotates (A1 regression)', async () => {
    const config = baseConfig({ compressTools: [] })
    const { layer, result, next, rewriteOf } = runLayer(config, { from: 'cat big.log', to: 'rtk read big.log' })
    const decision = await layer.listener(exec, result, next, rewriteOf)
    expect(decision.kind).toBe('accept')
    const content = (decision as { content: { text: string }[] }).content
    expect(content).toHaveLength(1)
    expect(content[0]?.text.startsWith('[rtk] ran: rtk read big.log\n')).toBe(true)
    expect(content[0]?.text.length).toBeGreaterThan(1000)
  })

  it('skips the annotation when the body is shorter than the threshold', async () => {
    const config = baseConfig({ compressTools: [], annotateMinBytes: 500 })
    const layer = createCompressLayer({ binary: 'rtk', timeoutMs: 50, env: {}, config })
    const small = { isError: false, content: [{ type: 'text', text: 'M src/a.ts\n' }] } as never
    const next = async (): Promise<never> => ({ kind: 'accept' }) as never
    const decision = await layer.listener(exec, small, next, () => ({ from: 'git status', to: 'rtk git status' }))
    expect(decision).toEqual({ kind: 'accept' })
  })

  it('does nothing when neither compression nor annotation applies', async () => {
    const config = baseConfig({ compressTools: [] })
    const { layer, result, next, rewriteOf } = runLayer(config)
    const decision = await layer.listener(exec, result, next, rewriteOf)
    expect(decision).toEqual({ kind: 'accept' })
  })

  it('prepends the annotation as its own block for non-text content', async () => {
    const config = baseConfig({ compressTools: [] })
    const layer = createCompressLayer({ binary: 'rtk', timeoutMs: 50, env: {}, config })
    const image = { type: 'image', data: 'x' } as never
    const result = { isError: false, content: [image] } as never
    const next = async (): Promise<never> => ({ kind: 'accept' }) as never
    const decision = await layer.listener(exec, result, next, () => ({ from: 'a', to: 'rtk a' }))
    const content = (decision as { content: { type: string; text?: string }[] }).content
    expect(content).toHaveLength(2)
    expect(content[0]?.text).toBe('[rtk] ran: rtk a')
    expect(content[1]).toBe(image)
  })

  it('never overrides a downstream value replacement', async () => {
    const config = baseConfig()
    const layer = createCompressLayer({ binary: 'rtk', timeoutMs: 50, env: {}, config })
    const result = { isError: false, content: [{ type: 'text', text: 'x'.repeat(4096) }] } as never
    const downstream = { kind: 'accept', value: { replaced: true } } as never
    const next = async (): Promise<never> => downstream
    const decision = await layer.listener(exec, result, next, () => undefined)
    expect(decision).toBe(downstream)
  })

  it('reports a foreign transform when downstream replaced the content', async () => {
    const config = baseConfig({ compressTools: [] })
    let foreign = 0
    const layer = createCompressLayer({
      binary: 'rtk',
      timeoutMs: 50,
      env: {},
      config,
      onForeignTransform: () => {
        foreign += 1
      },
    })
    const result = { isError: false, content: [{ type: 'text', text: 'original' }] } as never
    const downstream = { kind: 'accept', content: [{ type: 'text', text: 'theirs' }] } as never
    const next = async (): Promise<never> => downstream
    await layer.listener(exec, result, next, () => undefined)
    expect(foreign).toBe(1)
  })

  it('skips PTC sub-calls', async () => {
    const config = baseConfig()
    const layer = createCompressLayer({ binary: 'rtk', timeoutMs: 50, env: {}, config })
    const subCall = { name: 'bash', arguments: { command: 'cat x' }, parent: Symbol('parent') } as never
    const result = { isError: false, content: [{ type: 'text', text: 'x'.repeat(4096) }] } as never
    const next = async (): Promise<never> => ({ kind: 'accept' }) as never
    expect(await layer.listener(subCall, result, next, () => ({ from: 'a', to: 'rtk a' }))).toEqual({ kind: 'accept' })
  })
})
