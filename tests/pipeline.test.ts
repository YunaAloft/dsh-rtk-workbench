import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePipelineProblems, parsePipelineShow, pipelineEnv } from '../src/rtk/pipeline'

describe('pipeline show parsing', () => {
  it('reads the resolved name of a healthy pipeline', () => {
    const info = parsePipelineShow('Pipeline: dsh-rtk-workbench\nInherits: rtk:posthook\n')
    expect(info.name).toBe('dsh-rtk-workbench')
    expect(info.fellBack).toBe(false)
    expect(info.dropped).toEqual([])
    expect(info.untrusted).toEqual([])
  })

  it('detects the built-in fallback', () => {
    const info = parsePipelineShow(
      'Pipeline: rtk:default\n(fell back to the built-in default — see diagnostics below)\n',
    )
    expect(info.name).toBe('rtk:default')
    expect(info.fellBack).toBe(true)
  })

  it('collects dropped files and trust diagnostics', () => {
    const text = [
      'Pipeline: rtk:default',
      '(not loaded, has errors: C:/x/pipeline.toml — the other files are active; see diagnostics below)',
      'C:/p/.rtk/pipeline.toml is untrusted — not loaded; review with rtk trust',
      'C:/p/.rtk/filters.toml changed since it was trusted — not loaded; review with rtk trust',
    ].join('\n')
    const info = parsePipelineShow(text)
    expect(info.dropped).toHaveLength(1)
    expect(info.untrusted).toHaveLength(2)
  })
})

describe('pipeline status parsing', () => {
  it('strips the header and the consequence line', () => {
    const output = [
      'pipeline: problems recorded at the last hook invocation',
      '/tmp/p/pipeline.toml has errors and is not loaded — your other pipeline files stay active',
      'hooks are running the built-in rtk:default until this is fixed',
    ].join('\n')
    expect(parsePipelineProblems(output)).toEqual([
      '/tmp/p/pipeline.toml has errors and is not loaded — your other pipeline files stay active',
    ])
  })

  it('returns nothing for an empty report', () => {
    expect(parsePipelineProblems('')).toEqual([])
  })
})

describe('pipeline env modes', () => {
  it('injects RTK_CONFIG_DIR for auto and plugin-owned, but not for user', () => {
    const home = mkdtempSync(join(tmpdir(), 'rtk-home-'))
    try {
      const base = { DSH_HOME: home }
      const user = pipelineEnv('user', base)
      expect(user.configDir).toBe('')
      expect(user.env).toBe(base)

      const auto = pipelineEnv('auto', base)
      expect(auto.configDir).not.toBe('')
      expect(auto.env.RTK_CONFIG_DIR).toBe(auto.configDir)
      expect(readFileSync(join(auto.configDir, 'pipeline.toml'), 'utf8')).toContain('extends = "rtk:posthook"')

      const owned = pipelineEnv('plugin-owned', base)
      expect(owned.env.RTK_CONFIG_DIR).toBe(owned.configDir)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
