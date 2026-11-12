import { describe, expect, it } from 'vitest'
import { isRtkInvocation, isWorthRewriting, rewriteInvocation, verbOf } from '../src/rtk/rewrite'

describe('isRtkInvocation', () => {
  it('recognises the shapes a shell can put around the binary', () => {
    expect(isRtkInvocation('rtk git status')).toBe(true)
    expect(isRtkInvocation('RTK git status')).toBe(true)
    expect(isRtkInvocation('"rtk" git status')).toBe(true)
    expect(isRtkInvocation("'rtk' git status")).toBe(true)
    expect(isRtkInvocation('/usr/local/bin/rtk git status')).toBe(true)
    expect(isRtkInvocation('C:\\tools\\rtk.exe git status')).toBe(true)
    expect(isRtkInvocation('"C:/Program Files/rtk/rtk.exe" git status')).toBe(true)
  })

  it('sees through environment prefixes', () => {
    expect(isRtkInvocation('FOO=1 rtk git status')).toBe(true)
    expect(isRtkInvocation('A=1 B="two words" rtk git status')).toBe(true)
    expect(isRtkInvocation('RTK_DISABLE=1 rtk git status')).toBe(true)
    expect(isRtkInvocation('FOO=1 git status')).toBe(false)
  })

  it('does not match a command merely containing rtk', () => {
    expect(isRtkInvocation('git rtk status')).toBe(false)
    expect(isRtkInvocation('myrtk git status')).toBe(false)
    expect(isRtkInvocation('echo rtk')).toBe(false)
  })
})

describe('pre-filter recursion guard', () => {
  it('skips every already-rewritten spelling instead of paying a second spawn', () => {
    expect(isWorthRewriting('rtk git status')).toBe(false)
    expect(isWorthRewriting('FOO=1 rtk git status')).toBe(false)
    expect(isWorthRewriting('"rtk" git status')).toBe(false)
    expect(isWorthRewriting('RTK git status')).toBe(false)
    expect(isWorthRewriting('C:\\tools\\rtk.exe git status')).toBe(false)
    expect(isWorthRewriting('cd repo && FOO=1 rtk git status')).toBe(false)
  })

  it('keeps an env-prefixed real command eligible', () => {
    expect(isWorthRewriting('FOO=1 git status')).toBe(true)
    expect(isWorthRewriting('A=1 B=2 cargo test')).toBe(true)
  })

  it('still defers on env-prefixed builtins and excluded commands', () => {
    expect(isWorthRewriting('FOO=1 cd /tmp && echo hi')).toBe(false)
    expect(isWorthRewriting('FOO=1 cat big.log', 'posix', new Set(['cat']))).toBe(false)
  })
})

describe('rewriteInvocation', () => {
  it('passes ordinary commands straight through', () => {
    expect(rewriteInvocation('git status')).toEqual(['rewrite', 'git status'])
  })

  it('inserts -- when the command starts with a dash so clap cannot read it as a flag', () => {
    // Without --, `rtk rewrite -h` prints rtk's own help and exits 0; the help
    // text would then look like an allowed rewrite.
    expect(rewriteInvocation('-h')).toEqual(['rewrite', '--', '-h'])
    expect(rewriteInvocation('  --help')).toEqual(['rewrite', '--', '  --help'])
    expect(rewriteInvocation('git -C repo status')).toEqual(['rewrite', 'git -C repo status'])
  })
})

describe('verbOf', () => {
  it('names the verb behind env prefixes, quotes and paths', () => {
    expect(verbOf('FOO=1 git status')).toBe('git')
    expect(verbOf('"cargo" test')).toBe('cargo')
    expect(verbOf('C:\\tools\\Git.exe status')).toBe('git')
    expect(verbOf('')).toBeUndefined()
  })
})
