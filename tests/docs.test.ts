import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELP, HELP_TOPICS } from '../src/commands'

/** Long-form manual must keep up with the in-terminal help. */
const english = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8')
const chinese = readFileSync(new URL('../docs/reference.zh.md', import.meta.url), 'utf8')

describe('help and reference stay in sync', () => {
  it('documents every subcommand on both manuals', () => {
    for (const command of ['status', 'stats', 'tools', 'explain', 'doctor', 'gain', 'recall', 'help']) {
      expect(HELP).toContain(command)
      expect(english).toContain(`/rtk ${command}`)
      expect(chinese).toContain(`/rtk ${command}`)
    }
  })

  it('documents every help topic', () => {
    for (const topic of Object.keys(HELP_TOPICS)) {
      expect(english).toContain(topic)
      expect(chinese).toContain(topic)
    }
  })

  it('names the knobs a user needs first', () => {
    for (const key of ['rewriteEnabled', 'compressEnabled', 'pipelineMode', 'spillOriginal']) {
      expect(HELP_TOPICS.config).toContain(key)
      expect(english).toContain(key)
      expect(chinese).toContain(key)
    }
  })
})
