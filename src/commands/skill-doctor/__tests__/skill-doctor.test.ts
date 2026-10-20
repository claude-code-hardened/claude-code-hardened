import { describe, expect, test } from 'bun:test'
import {
  SKILL_DOCTOR_CATEGORIES,
  SKILL_DOCTOR_SAMPLE,
  categorizeSkillUsage,
  formatSkillDoctorBuckets,
  formatSkillDoctorReport,
  formatSkillUsageDetail,
  parseSkillDoctorArgs,
} from '../engine.js'
import {
  runSkillDoctor,
  type SkillDoctorReport,
} from '../../../skills/skillDoctor.js'
import type { Command } from '../../../types/command.js'

describe('parseSkillDoctorArgs — /skill-doctor argument surface', () => {
  test('no args means run the report', () => {
    expect(parseSkillDoctorArgs('')).toEqual({ action: 'run' })
    expect(parseSkillDoctorArgs('   ')).toEqual({ action: 'run' })
  })

  test('demo previews the four-category layout with fixture data', () => {
    expect(parseSkillDoctorArgs('demo')).toEqual({ action: 'demo' })
  })

  test('help and unknown args', () => {
    expect(parseSkillDoctorArgs('help')).toEqual({ action: 'help' })
    const parsed = parseSkillDoctorArgs('wat')
    expect(parsed.action).toBe('invalid')
  })
})

describe('categorizeSkillUsage — four-category classification', () => {
  test('never-invoked skills land in attention', () => {
    expect(categorizeSkillUsage(SKILL_DOCTOR_SAMPLE[2])).toBe('attention')
  })

  test('31+ days is disused, 8-30 idle, <=7 active', () => {
    const make = (days: number) => ({
      name: 'x',
      source: 'userSettings',
      tokenEstimate: 10,
      invocations: 1,
      daysSinceUse: days,
      enabled: true,
    })
    expect(categorizeSkillUsage(make(31))).toBe('disused')
    expect(categorizeSkillUsage(make(12))).toBe('idle')
    expect(categorizeSkillUsage(make(7))).toBe('active')
  })

  test('category table exposes exactly four buckets', () => {
    expect(SKILL_DOCTOR_CATEGORIES.map(c => c.key)).toEqual([
      'attention',
      'disused',
      'idle',
      'active',
    ])
  })
})

describe('formatSkillDoctorReport — UI copy', () => {
  test('detail line matches anchored copy', () => {
    expect(formatSkillUsageDetail(SKILL_DOCTOR_SAMPLE[2])).toBe(
      '~310 tok · never used',
    )
    expect(formatSkillUsageDetail(SKILL_DOCTOR_SAMPLE[0])).toBe(
      '~128 tok · 42x today',
    )
  })

  test('empty report lists the categories and no stale TODO marker', () => {
    const report = formatSkillDoctorReport([])
    expect(report).toContain('Needs attention')
    // W5 is shipped: the real engine runs, so no TODO/W5/TODO markers remain.
    expect(report).not.toContain('TODO')
    expect(report).not.toContain('not wired')
  })

  test('non-empty report ends with the anchored total line', () => {
    const report = formatSkillDoctorReport(SKILL_DOCTOR_SAMPLE)
    expect(report).toContain('Total 45 uses across 3 skills')
  })
})

describe('formatSkillDoctorBuckets — official loaded-from four buckets (fix-item 7)', () => {
  function promptSkill(name: string, loadedFrom: string): Command {
    return {
      type: 'prompt',
      name,
      description: `${name} skill`,
      source: 'test-source',
      loadedFrom,
      isEnabled: () => true,
      getPromptForCommand: async () => [],
    } as unknown as Command
  }

  test('renders the official buckets from the report', () => {
    const skills: Command[] = [
      promptSkill('owned-skill', 'skills'),
      promptSkill('plug-skill', 'plugin'),
      promptSkill('mcp-skill', 'mcp'),
      promptSkill('synced-skill', 'syncedSkills'),
    ]
    const report: SkillDoctorReport = runSkillDoctor(skills, {
      usageLookup: () => ({ usageCount: 0, lastUsedAt: 0 }),
      now: 1_000_000,
    })
    const text = formatSkillDoctorBuckets(report)
    expect(text).toContain('Loaded but never invoked, by source:')
    expect(text).toContain('Owned (user-manageable local skills')
    expect(text).toContain('Contributed by plugins')
    expect(text).toContain('Surfaced via MCP')
    expect(text).toContain('Synced from claude.ai')
    expect(text).toContain('owned-skill [skills]')
    expect(text).toContain('plug-skill [plugin]')
    expect(text).toContain('mcp-skill [mcp]')
    expect(text).toContain('synced-skill [syncedSkills]')
  })

  test('null when nothing is unused and when no skills are loaded', () => {
    const used = runSkillDoctor([promptSkill('busy-skill', 'skills')], {
      usageLookup: () => ({ usageCount: 3, lastUsedAt: Date.now() }),
    })
    expect(formatSkillDoctorBuckets(used)).toBeNull()
    expect(formatSkillDoctorBuckets(runSkillDoctor([], {}))).toBeNull()
  })
})
