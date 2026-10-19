import { describe, expect, test } from 'bun:test'
import { RELOAD_SKILLS_USAGE, parseReloadSkillsArgs } from '../args.js'

describe('parseReloadSkillsArgs — /reload-skills argument surface', () => {
  test('no args means reload', () => {
    expect(parseReloadSkillsArgs('')).toEqual({ action: 'reload' })
    expect(parseReloadSkillsArgs('   ')).toEqual({ action: 'reload' })
  })

  test('rejects any argument with usage text', () => {
    const parsed = parseReloadSkillsArgs('all')
    expect(parsed).toEqual({
      action: 'invalid',
      error: '/reload-skills takes no arguments (got "all")',
    })
  })

  test('help action exposes usage copy', () => {
    expect(parseReloadSkillsArgs('help')).toEqual({ action: 'help' })
    expect(RELOAD_SKILLS_USAGE).toContain('/reload-skills')
  })
})
