/**
 * Settings parse-face for aliasSkillToolNames (R5). The settings JSON
 * `toolAliases` map (alias -> canonical tool name) is produced onto rules at
 * parse time and consulted at match time — so an alias declared in settings
 * genuinely gates permission checks ("配置别名 → 权限命中" e2e clause).
 * settingsJsonToRules is pure over (data, source); no settings mocks needed.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { SettingsJson } from '../../settings/types.js'

import {
  getToolAliasesForSource,
  settingsJsonToRules,
  setToolAliasesForTest,
} from '../permissionsLoader'
import {
  getDenyRuleForTool,
  getRuleByContentsForToolName,
} from '../permissions'
import { getEmptyToolPermissionContext } from '../../../Tool.js'

afterEach(() => {
  setToolAliasesForTest(null)
})

function makeSettings(
  toolAliases: Record<string, string>,
  deny: string[],
): SettingsJson {
  return {
    toolAliases,
    permissions: { deny },
  } as SettingsJson
}

describe('settingsJsonToRules — toolAliases parse face (R5)', () => {
  test('rules authored against the canonical name carry the alias names', () => {
    const rules = settingsJsonToRules(
      makeSettings({ Skill: 'SkillTool' }, [
        'SkillTool',
        'SkillTool(dangerous)',
      ]),
      'projectSettings',
    )
    expect(rules).toHaveLength(2)
    for (const rule of rules) {
      expect(rule.aliasSkillToolNames).toEqual(['Skill'])
    }
    // The rule whose toolName IS the alias entry carries no aliases.
    const aliasAuthored = settingsJsonToRules(
      makeSettings({ Skill: 'SkillTool' }, ['Skill']),
      'projectSettings',
    )
    expect(aliasAuthored[0].aliasSkillToolNames).toBeUndefined()
  })

  test('no toolAliases in settings → rules carry no aliases (historical shape)', () => {
    const rules = settingsJsonToRules(
      { permissions: { deny: ['SkillTool'] } } as SettingsJson,
      'userSettings',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0].aliasSkillToolNames).toBeUndefined()
  })

  test('getToolAliasesForSource degrades to {} on null settings', () => {
    expect(getToolAliasesForSource(null)).toEqual({})
  })
})

describe('configured alias → permission hit (e2e clause)', () => {
  function makeContext(denyRules: string[]) {
    const ctx = getEmptyToolPermissionContext()
    return { ...ctx, alwaysDenyRules: { localSettings: denyRules } } as any
  }

  test('deny SkillTool hits a Skill(name) call once the alias is configured', () => {
    setToolAliasesForTest({ Skill: 'SkillTool' })
    const ctx = makeContext(['SkillTool'])
    const rule = getDenyRuleForTool(ctx, { name: 'Skill', mcpInfo: undefined })
    expect(rule).not.toBeNull()
    expect(rule?.ruleValue.toolName).toBe('SkillTool')
  })

  test('content deny SkillTool(preview:*) gates Skill via the alias', () => {
    setToolAliasesForTest({ Skill: 'SkillTool' })
    const byContents = getRuleByContentsForToolName(
      makeContext(['SkillTool(preview:*)']),
      'Skill',
      'deny',
    )
    expect(byContents.get('preview:*')?.ruleValue.toolName).toBe('SkillTool')
  })

  test('without the alias configured, SkillTool rules do not hit Skill', () => {
    setToolAliasesForTest({})
    const ctx = makeContext(['SkillTool'])
    expect(
      getDenyRuleForTool(ctx, { name: 'Skill', mcpInfo: undefined }),
    ).toBeNull()
  })
})
