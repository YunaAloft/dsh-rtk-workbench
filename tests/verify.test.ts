import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideRewrite } from '../src/rtk/rewrite'
import { verifyRewrite } from '../src/rtk/verify'

interface Corpus {
  readonly cases: ReadonlyArray<readonly [string, string, 'accept' | 'reject']>
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/rewrite-corpus.json', import.meta.url), 'utf8'),
) as Corpus

describe('semantic guard: corpus', () => {
  for (const [command, proposal, expected] of corpus.cases) {
    it(`${expected === 'accept' ? 'accepts' : 'rejects'} ${command} -> ${proposal}`, () => {
      const verdict = verifyRewrite(command, proposal)
      expect(verdict.ok).toBe(expected === 'accept')
    })
  }
})

describe('semantic guard: structure', () => {
  it('accepts a prefix rewrite on every segment of a compound command', () => {
    expect(verifyRewrite('cd repo && cargo test', 'cd repo && rtk cargo test').ok).toBe(true)
  })

  it('rejects a proposal that merges or splits segments', () => {
    expect(verifyRewrite('git status && git log', 'rtk git status && git log && echo done')).toEqual({
      ok: false,
      reason: 'segment-mismatch',
    })
  })

  it('rejects an added environment assignment even when the tail matches', () => {
    expect(verifyRewrite('git status', 'DEBUG=1 rtk git status')).toEqual({
      ok: false,
      reason: 'env-mismatch',
    })
  })

  it('keeps a gradle-to-gradlew mapping only when the arguments survive', () => {
    expect(verifyRewrite('gradle build --info', 'rtk gradlew build --info').ok).toBe(true)
    expect(verifyRewrite('gradle build --info', 'rtk gradlew build').ok).toBe(false)
  })

  it('keeps a read mapping only when the path and line window survive', () => {
    expect(verifyRewrite('head -20 app.log', 'rtk read app.log --head-lines 20').ok).toBe(true)
    expect(verifyRewrite('head -20 app.log', 'rtk read app.log').ok).toBe(false)
    expect(verifyRewrite('cat app.log', 'rtk read other.log').ok).toBe(false)
  })

  it('rejects an empty segment list', () => {
    expect(verifyRewrite('', 'rtk git status')).toEqual({ ok: false, reason: 'segment-mismatch' })
  })
})

describe('decideRewrite with the semantic guard', () => {
  it('accepts rtk next for next build: the rtk command always appends the build subcommand', () => {
    expect(decideRewrite('next build', { code: 3, stdout: 'rtk next\n' })).toEqual({
      kind: 'rewrite',
      command: 'rtk next',
    })
    expect(decideRewrite('next build --turbo', { code: 3, stdout: 'rtk next --turbo\n' })).toEqual({
      kind: 'rewrite',
      command: 'rtk next --turbo',
    })
  })

  it('refuses a proposal that dropped an argument', () => {
    expect(decideRewrite('next build --turbo', { code: 3, stdout: 'rtk next\n' })).toEqual({
      kind: 'none',
      reason: 'guard',
    })
    expect(decideRewrite('python -m pytest', { code: 3, stdout: 'rtk pytest\n' })).toEqual({
      kind: 'none',
      reason: 'guard',
    })
  })

  it('names the mapping that proved equivalence, for /rtk explain', () => {
    expect(verifyRewrite('next build', 'rtk next')).toEqual({ ok: true, via: 'next-build' })
    expect(verifyRewrite('git status', 'rtk git status')).toEqual({ ok: true, via: 'prefix' })
    expect(verifyRewrite('gradle build', 'rtk gradlew build')).toEqual({ ok: true, via: 'gradle' })
    expect(verifyRewrite('head -20 f.txt', 'rtk read f.txt --head-lines 20')).toEqual({
      ok: true,
      via: 'read',
    })
  })

  it('can be disabled for a future rtk whose mapping the guard cannot prove', () => {
    expect(
      decideRewrite('next build', { code: 3, stdout: 'rtk next\n' }, { semanticGuard: false }),
    ).toEqual({ kind: 'rewrite', command: 'rtk next' })
  })

  it('still accepts a plain prefix rewrite', () => {
    expect(decideRewrite('git status', { code: 3, stdout: 'rtk git status\n' })).toEqual({
      kind: 'rewrite',
      command: 'rtk git status',
    })
  })
})
