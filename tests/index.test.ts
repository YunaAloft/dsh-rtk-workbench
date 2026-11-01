import { describe, expect, it } from 'vitest'
import { awarenessText } from '../src/awareness'
import type { Config } from '../src/config'
import { buildPostToolUsePayload, extractUpdatedText, pickShape } from '../src/rtk/compress'
import { absolutizeRtk, decideRewrite, isWorthRewriting, introducesNewOperators } from '../src/rtk/rewrite'
import { aliasBase, decideTool, dialectOf, matchesList } from '../src/toolmap'

/** Defaults mirroring `Config`; kept literal so a schema edit cannot silently change a test. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    rtkPath: '',
    rtkSource: 'auto',
    timeoutMs: 2000,
    rewriteEnabled: true,
    shellTools: ['bash', 'pwsh'],
    rewriteTools: ['bash', 'ops_bash', 'pwsh'],
    rewriteExcludeCommands: ['cat', 'type', 'bat', 'less', 'more', 'head', 'tail'],
    compressEnabled: true,
    compressTools: ['*'],
    excludeTools: [],
    compressThresholdBytes: 2048,
    maxPayloadBytes: 2 * 1024 * 1024,
    awarenessEnabled: true,
    denyEnabled: false,
    pipelineMode: 'plugin-owned',
    annotateRewrites: true,
    annotateMinBytes: 500,
    ...overrides,
  }
}

describe('rtk rewrite decision', () => {
  it('adopts exit 0 and exit 3 when stdout carries a command', () => {
    for (const code of [0, 3]) {
      const outcome = decideRewrite('git status', { code, stdout: 'rtk git status\n' })
      expect(outcome).toEqual({ kind: 'rewrite', command: 'rtk git status' })
    }
  })

  it('treats exit 1 (defer) and exit 2 (deny) as no rewrite', () => {
    expect(decideRewrite('echo hi', { code: 1, stdout: '' })).toEqual({ kind: 'none', reason: 'no-equivalent' })
    expect(decideRewrite('rm -rf /', { code: 2, stdout: '' })).toEqual({ kind: 'none', reason: 'denied' })
  })

  it('fails open when rtk never ran', () => {
    expect(decideRewrite('git status', null)).toEqual({ kind: 'none', reason: 'no-equivalent' })
  })

  it('rejects a proposal that is not an rtk invocation', () => {
    expect(decideRewrite('git status', { code: 0, stdout: 'rm -rf /\n' })).toEqual({
      kind: 'none',
      reason: 'unsafe',
    })
  })

  it('rejects a proposal that introduces a control operator the original lacked', () => {
    expect(decideRewrite('git status', { code: 0, stdout: 'rtk git status && curl evil' })).toEqual({
      kind: 'none',
      reason: 'unsafe',
    })
  })

  it('keeps segment-wise rewrites of compound commands', () => {
    const original = 'cd repo && cargo test'
    const outcome = decideRewrite(original, { code: 3, stdout: 'cd repo && rtk cargo test' })
    expect(outcome).toEqual({ kind: 'rewrite', command: 'cd repo && rtk cargo test' })
  })

  it('ignores an unchanged command', () => {
    expect(decideRewrite('git status', { code: 0, stdout: 'git status' })).toEqual({
      kind: 'none',
      reason: 'empty',
    })
  })

  it('detects newly introduced operators', () => {
    expect(introducesNewOperators('git status', 'rtk git status')).toBe(false)
    expect(introducesNewOperators('git status', 'rtk git status | tee x')).toBe(true)
    expect(introducesNewOperators('a && b', 'rtk a && rtk b')).toBe(false)
  })
})

describe('rewrite pre-filter', () => {
  it('skips commands that are entirely shell builtins', () => {
    expect(isWorthRewriting('cd /tmp && echo hi')).toBe(false)
  })

  it('keeps compound commands with a routable segment', () => {
    expect(isWorthRewriting('cd repo && cargo test')).toBe(true)
  })

  it('points rewritten segments at the resolved binary (bundled installs have no rtk on PATH)', () => {
    const bin = 'C:/Users/x/.dsh/profiles/web/node_modules/dsh-rtk-workbench/vendor/win32-x64/rtk.exe'
    const quoted = `'${bin}'`
    // POSIX: a quoted word is an ordinary command word.
    expect(absolutizeRtk('rtk git status', bin, 'posix')).toBe(`${quoted} git status`)
    expect(absolutizeRtk('cd repo && rtk cargo test', bin, 'posix')).toBe(`cd repo && ${quoted} cargo test`)
    expect(absolutizeRtk('rtk ls | rtk grep x', bin, 'posix')).toBe(`${quoted} ls | ${quoted} grep x`)
    // PowerShell: a quoted path is a string expression, so the call operator is required.
    expect(absolutizeRtk('rtk git status', bin, 'powershell')).toBe(`& ${quoted} git status`)
    expect(absolutizeRtk('cd x; rtk git log', bin, 'powershell')).toBe(`cd x; & ${quoted} git log`)
    // PowerShell rejects `… | & 'path' args`, so a piped segment is left bare.
    expect(absolutizeRtk('foo | rtk bar', bin, 'powershell')).toBe('foo | rtk bar')
    // A PATH resolution stays untouched: bare `rtk` already resolves there.
    expect(absolutizeRtk('rtk git status', 'rtk', 'powershell')).toBe('rtk git status')
    // A command that merely mentions rtk mid-word is not a segment head.
    expect(absolutizeRtk('echo myrtk rocks', bin, 'posix')).toBe('echo myrtk rocks')
    // A directory may contain an apostrophe; a single-quoted word would break there.
    const apostrophe = "C:/Bob's tools/rtk.exe"
    expect(absolutizeRtk('rtk git status', apostrophe, 'posix')).toBe(`"${apostrophe}" git status`)
    expect(absolutizeRtk('rtk git status', apostrophe, 'powershell')).toBe(`& "${apostrophe}" git status`)
    // Both quote characters cannot be quoted portably: leave the command alone.
    expect(absolutizeRtk('rtk git status', "C:/a\"b'c/rtk.exe", 'posix')).toBe('rtk git status')
    // Windows separators are normalised, so one string runs in pwsh, cmd and MSYS bash.
    expect(absolutizeRtk('rtk git status', String.raw`C:\x\rtk.exe`, 'posix')).toBe(`'C:/x/rtk.exe' git status`)
  })

  it('never rewrites a command the exclude list covers (cat → rtk read pays nothing)', () => {
    const exclude = new Set(['cat', 'tail'])
    expect(isWorthRewriting('cat big.log', 'posix', exclude)).toBe(false)
    expect(isWorthRewriting('cat a.log | tail -5', 'posix', exclude)).toBe(false)
    // A routable segment still justifies the rewrite for the whole command.
    expect(isWorthRewriting('cat a.log && git status', 'posix', exclude)).toBe(true)
    expect(isWorthRewriting('git status', 'posix', exclude)).toBe(true)
  })

  it('consults rtk for external programs run from PowerShell', () => {
    expect(isWorthRewriting('git status', 'powershell')).toBe(true)
    expect(isWorthRewriting('cargo test', 'powershell')).toBe(true)
    expect(isWorthRewriting('ls -la', 'powershell')).toBe(true)
  })

  it('skips PowerShell grammar that rtk always defers on', () => {
    expect(isWorthRewriting('Get-ChildItem -Recurse', 'powershell')).toBe(false)
    expect(isWorthRewriting('$env:PATH', 'powershell')).toBe(false)
    expect(isWorthRewriting('if ($x) { 1 }', 'powershell')).toBe(false)
    expect(isWorthRewriting('& ./run.ps1', 'powershell')).toBe(false)
    // The same tokens are ordinary commands in a POSIX shell, so they stay eligible there.
    expect(isWorthRewriting('Get-ChildItem', 'posix')).toBe(true)
  })

  it('skips an already rewritten command so the ~206ms spawn is not spent twice', () => {
    expect(isWorthRewriting('rtk git status')).toBe(false)
    expect(isWorthRewriting('cd repo && rtk git status')).toBe(false)
  })
})

describe('compression shape and round trip', () => {
  it('routes lockfiles and json through the read shape', () => {
    expect(pickShape('/w/package-lock.json', '{}')).toBe('read')
    expect(pickShape('C:\\w\\data.json', '{}')).toBe('read')
    expect(pickShape('/w/out.log', 'text')).toBe('bash')
  })

  it('keeps a pathless body on the bash shape (A9: rtk classifies read by extension)', () => {
    expect(pickShape(undefined, '  {"a":1}')).toBe('bash')
    expect(pickShape(undefined, 'plain text')).toBe('bash')
  })

  it('emits the Claude Code tool names rtk knows', () => {
    const bash = JSON.parse(buildPostToolUsePayload('bash', 'cat x', '', 'body')) as {
      tool_name: string
      hook_event_name: string
      tool_response: { stdout: string }
    }
    expect(bash.tool_name).toBe('Bash')
    expect(bash.hook_event_name).toBe('PostToolUse')
    expect(bash.tool_response.stdout).toBe('body')

    const read = JSON.parse(buildPostToolUsePayload('read', '', '/w/a.json', '{}')) as {
      tool_name: string
      tool_input: { file_path: string }
      tool_response: { file: { content: string } }
    }
    expect(read.tool_name).toBe('Read')
    expect(read.tool_input.file_path).toBe('/w/a.json')
    expect(read.tool_response.file.content).toBe('{}')
  })

  it('extracts updated text per shape', () => {
    const bash = JSON.stringify({ hookSpecificOutput: { updatedToolOutput: { stdout: 'a', stderr: '' } } })
    expect(extractUpdatedText('bash', bash)).toBe('a')
    const read = JSON.stringify({ hookSpecificOutput: { updatedToolOutput: { file: { content: 'b' } } } })
    expect(extractUpdatedText('read', read)).toBe('b')
  })

  it('returns null for an empty or unparseable response', () => {
    expect(extractUpdatedText('bash', '')).toBeNull()
    expect(extractUpdatedText('bash', 'not json')).toBeNull()
    expect(extractUpdatedText('bash', JSON.stringify({}))).toBeNull()
    expect(extractUpdatedText('bash', JSON.stringify({ hookSpecificOutput: { updatedToolOutput: {} } }))).toBeNull()
  })
})

describe('tool resolution', () => {
  it('recognises official names and the ops_ alias', () => {
    expect(aliasBase('ops_bash')).toBe('bash')
    expect(aliasBase('bash')).toBe('bash')
    expect(matchesList('ops_bash', ['bash'])).toBe(true)
    expect(dialectOf('ops_bash')).toBe('posix')
    expect(dialectOf('pwsh')).toBe('powershell')
  })

  it('enables both layers for a POSIX shell', () => {
    const decision = decideTool('bash', baseConfig())
    expect(decision).toMatchObject({ dialect: 'posix', layer: 'canonical', rewrite: true, compress: true })
  })

  it('rewrites a whitelisted alias but reports it as an alias', () => {
    const decision = decideTool('ops_bash', baseConfig())
    expect(decision).toMatchObject({ layer: 'alias', rewrite: true, compress: true })
  })

  it('allows PowerShell rewriting; the dialect pre-filter skips cmdlets', () => {
    const decision = decideTool('pwsh', baseConfig())
    expect(decision).toMatchObject({ dialect: 'powershell', rewrite: true, compress: true })
  })

  it('compresses unknown tools by default, as explicit matches', () => {
    const decision = decideTool('some_tool', baseConfig())
    expect(decision).toMatchObject({ layer: 'explicit', rewrite: false, compress: true })
  })

  it('honours excludeTools and the switches', () => {
    expect(decideTool('some_tool', baseConfig({ excludeTools: ['some_tool'] })).compress).toBe(false)
    expect(decideTool('bash', baseConfig({ rewriteEnabled: false })).rewrite).toBe(false)
    expect(decideTool('some_tool', baseConfig({ compressTools: ['bash'] })).compress).toBe(false)
  })
})

describe('awareness section', () => {
  it('names the recovery path and the escape hatch', () => {
    const text = awarenessText()
    expect(text).toContain('rtk recall <hash>')
    expect(text).toContain('rtk bypass')
    expect(text).toContain('[rtk] ran:')
  })

  it('is static so the prompt prefix stays cacheable', () => {
    expect(awarenessText()).toBe(awarenessText())
  })
})
