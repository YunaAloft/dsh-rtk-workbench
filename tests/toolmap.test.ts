import { describe, expect, it } from 'vitest'
import { isShellLike } from '../src/toolmap'

describe('shell-like tool detection', () => {
  it('recognises the official shells and aliases', () => {
    expect(isShellLike('bash')).toBe(true)
    expect(isShellLike('pwsh')).toBe(true)
    expect(isShellLike('ops_bash')).toBe(true)
    expect(isShellLike('powershell')).toBe(true)
  })

  it('recognises shells republished under a suffixed name', () => {
    expect(isShellLike('my_shell')).toBe(true)
    expect(isShellLike('remote_bash')).toBe(true)
  })

  it('does not treat file or search tools as shells', () => {
    expect(isShellLike('read')).toBe(false)
    expect(isShellLike('grep')).toBe(false)
    expect(isShellLike('ops_read_files')).toBe(false)
    expect(isShellLike('bashful')).toBe(false)
  })
})
