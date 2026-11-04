import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLifetimeStore, defaultStatsFile } from '../src/stats-file'

const directories: string[] = []

/** One isolated ledger path inside a fresh temp directory. */
function ledgerPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'rtk-workbench-stats-'))
  directories.push(directory)
  return path.join(directory, 'nested', 'stats.json')
}

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

describe('lifetime ledger', () => {
  it('counts compressions, rewrites, fallbacks and guards', async () => {
    const file = ledgerPath()
    const store = createLifetimeStore({ enabled: true, file })
    store.load()
    store.record({ kind: 'compress', inBytes: 1000, outBytes: 200, savedTokens: 190 })
    store.record({ kind: 'rewrite' })
    store.record({ kind: 'rewrite' })
    store.record({ kind: 'fallback' })
    store.record({ kind: 'guard' })
    await store.flush()

    const snapshot = store.snapshot()
    expect(snapshot?.compressions).toBe(1)
    expect(snapshot?.inBytes).toBe(1000)
    expect(snapshot?.outBytes).toBe(200)
    expect(snapshot?.savedTokens).toBe(190)
    expect(snapshot?.rewrites).toBe(2)
    expect(snapshot?.fallbacks).toBe(1)
    expect(snapshot?.guards).toBe(1)

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(written.version).toBe(1)
    expect(written.compressions).toBe(1)
  })

  it('reloads the previous ledger and keeps accumulating', async () => {
    const file = ledgerPath()
    const first = createLifetimeStore({ enabled: true, file })
    first.load()
    first.record({ kind: 'compress', inBytes: 500, outBytes: 250, savedTokens: 60 })
    await first.flush()

    const second = createLifetimeStore({ enabled: true, file })
    second.load()
    expect(second.snapshot()?.compressions).toBe(1)
    second.record({ kind: 'compress', inBytes: 500, outBytes: 250, savedTokens: 60 })
    await second.flush()
    expect(second.snapshot()?.compressions).toBe(2)
    expect(second.snapshot()?.savedTokens).toBe(120)
  })

  it('treats a truncated ledger as empty instead of throwing', () => {
    const file = ledgerPath()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{"version":1,"compressions":4', 'utf8')
    const store = createLifetimeStore({ enabled: true, file })
    store.load()
    expect(store.snapshot()?.compressions).toBe(0)
  })

  it('leaves no temporary file behind after a flush', async () => {
    const file = ledgerPath()
    const store = createLifetimeStore({ enabled: true, file })
    store.record({ kind: 'rewrite' })
    await store.flush()
    const names = readdirSync(path.dirname(file))
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('writes nothing when persistence is off', async () => {
    const file = ledgerPath()
    const store = createLifetimeStore({ enabled: false, file })
    store.load()
    store.record({ kind: 'compress', inBytes: 10, outBytes: 1, savedTokens: 2 })
    await store.flush()
    expect(store.snapshot()).toBeUndefined()
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })
})

describe('defaultStatsFile', () => {
  it('sits under the harness home', () => {
    expect(defaultStatsFile({ DSH_HOME: path.join('C:', 'tmp', 'dsh-home') })).toBe(
      path.join('C:', 'tmp', 'dsh-home', 'rtk-workbench', 'stats.json'),
    )
  })
})
