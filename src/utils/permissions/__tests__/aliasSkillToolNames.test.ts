import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import type { PermissionRule } from '../../../types/permissions.js'

mock.module('src/utils/log.ts', logMock)

const {
  ruleTargetsToolName,
  getDenyRuleForTool,
  getRuleByContentsForToolName,
} = await import('../permissions')
const { setToolAliasesForTest } = await import('../permissionsLoader')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')

function makeRule(
  toolName: string,
  aliasSkillToolNames?: string[],
  ruleContent?: string,
): PermissionRule {
  return {
    source: 'session',
    ruleBehavior: 'deny',
    ruleValue: { toolName, ruleContent },
    aliasSkillToolNames,
  }
}

function makeTool(name: string) {
  return { name, mcpInfo: undefined }
}

function makeContext(denyRules: string[]) {
  const ctx = getEmptyToolPermissionContext()
  return { ...ctx, alwaysDenyRules: { localSettings: denyRules } } as any
}

describe('ruleTargetsToolName (aliasSkillToolNames wiring, anchor 0023 m1/hh)', () => {
  test('matches the rule tool name directly', () => {
    expect(ruleTargetsToolName(makeRule('Skill'), 'Skill')).toBe(true)
  })

  test('matches through a declared aliasSkillToolNames entry', () => {
    // Rule packaged against a differently-named variant still targets Skill.
    const rule = makeRule('SkillTool', ['Skill'])
    expect(ruleTargetsToolName(rule, 'Skill')).toBe(true)
    // …and keeps matching its own declared name.
    expect(ruleTargetsToolName(rule, 'SkillTool')).toBe(true)
  })

  test('does not match unrelated tool names', () => {
    expect(ruleTargetsToolName(makeRule('SkillTool', ['Skill']), 'Read')).toBe(
      false,
    )
  })

  test('rules without aliases never match beyond their own name', () => {
    expect(ruleTargetsToolName(makeRule('Bash'), 'Skill')).toBe(false)
    expect(ruleTargetsToolName(makeRule('Bash', undefined), 'Bash')).toBe(true)
  })

  test('settings toolAliases: called alias name matches rules for the canonical tool', () => {
    // e2e shape from settings: {"toolAliases": {"Skill": "SkillTool"}} —
    // a deny rule authored against the canonical SkillTool genuinely gates
    // Skill(name) calls.
    setToolAliasesForTest({ Skill: 'SkillTool' })
    try {
      expect(ruleTargetsToolName(makeRule('SkillTool'), 'Skill')).toBe(true)
      // Inverse direction does not apply (alias → canonical, single-hop).
      expect(ruleTargetsToolName(makeRule('Skill'), 'SkillTool')).toBe(false)
    } finally {
      setToolAliasesForTest(null)
    }
  })

  test('skills under an alias are honored by whole-tool deny rules (settings toolAliases → hit)', () => {
    setToolAliasesForTest({ Skill: 'SkillTool' })
    try {
      const ctx = makeContext(['SkillTool'])
      const rule = getDenyRuleForTool(ctx, makeTool('Skill'))
      expect(rule).not.toBeNull()
      expect(rule!.ruleValue.toolName).toBe('SkillTool')
    } finally {
      setToolAliasesForTest(null)
    }
  })

  test('content rules keep gating the aliased tool name', () => {
    // ASSERTION DIRECTION (R5 fix): whole-tool matching ignores content rules
    // by contract (toolMatchesRule returns false when ruleContent is set), so
    // the content-rule gating face is getRuleByContentsForToolName — the alias
    // direction is asserted THERE, not via getDenyRuleForTool.
    setToolAliasesForTest({ Skill: 'SkillTool' })
    try {
      // Rule authored against the canonical tool with content gates the alias
      // call.
      const ctx = makeContext(['SkillTool(dangerous-command)'])
      const byContents = getRuleByContentsForToolName(ctx, 'Skill', 'deny')
      expect(byContents.get('dangerous-command')).toBeDefined()
      expect(byContents.get('dangerous-command')?.ruleValue.toolName).toBe(
        'SkillTool',
      )

      // A content rule for an unrelated tool name never gates Skill.
      const miss = getRuleByContentsForToolName(
        makeContext(['Read(secret)']),
        'Skill',
        'deny',
      )
      expect(miss.size).toBe(0)
    } finally {
      setToolAliasesForTest(null)
    }
  })

  test('content rules carried on the rule itself still gate through the alias carrier', () => {
    // Programmatic rule producer shape (aliasSkillToolNames on the rule): the
    // content-match face honors it like the whole-tool face does.
    const rule = makeRule('SkillTool', ['Skill'], 'dangerous-command')
    expect(ruleTargetsToolName(rule, 'Skill')).toBe(true)
  })
})
