import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'
import type { Command } from '../../types/command.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

interface SkillOverrides {
  name?: string
  source?: string
  loadedFrom?: string
  context?: 'inline' | 'fork'
  type?: 'prompt' | 'local' | 'local-jsx'
}

// Test-fixture mock data; the loose factory shape is cast at the boundary.
function makeDoctorSkill(overrides: SkillOverrides = {}): Command {
  return {
    type: overrides.type ?? 'prompt',
    name: overrides.name ?? 'weather',
    description: 'test skill',
    progressMessage: 'running',
    contentLength: 10,
    source: overrides.source ?? 'userSettings',
    loadedFrom: overrides.loadedFrom,
    context: overrides.context ?? 'inline',
    getPromptForCommand: async () => [],
  } as unknown as Command
}

const NOW = 1_000_000
const DAY = 24 * 60 * 60 * 1000

function used(count: number, daysAgo = 0) {
  return { usageCount: count, lastUsedAt: NOW - daysAgo * DAY }
}

const { runSkillDoctor, createSkillDoctorEngine, globalSkillUsageLookup } =
  await import('../skillDoctor.js')
const { SKILL_IDENTIFIER_PREFIX, SYNCED_SKILL_PREFIX } = await import(
  '../syncedSkills.js'
)
const { SKILL_DOCTOR_CATEGORIES } = await import(
  '../../commands/skill-doctor/engine.js'
)

describe('runSkillDoctor', () => {
  test('builds rows with source from the PromptCommand variant', () => {
    const report = runSkillDoctor(
      [makeDoctorSkill({ name: 'alpha', source: 'projectSettings' })],
      { usageLookup: () => used(3, 1), now: NOW },
    )
    expect(report.rows).toHaveLength(1)
    const row = report.rows[0]!
    expect(row.name).toBe('alpha')
    expect(row.source).toBe('projectSettings')
    expect(row.identifier).toBe(
      `${SKILL_IDENTIFIER_PREFIX}projectSettings:alpha`,
    )
    expect(row.context).toBe('inline')
    expect(row.usageCount).toBe(3)
    expect(row.lastUsedAt).toBe(NOW - DAY)
    expect(row.weekTokens).toBeGreaterThan(0)
  })

  test('classifies unused skills into the four loadedFrom buckets', () => {
    const report = runSkillDoctor(
      [
        makeDoctorSkill({ name: 'owned', loadedFrom: 'skills' }),
        makeDoctorSkill({ name: 'from-plugin', loadedFrom: 'plugin' }),
        makeDoctorSkill({ name: 'from-mcp', loadedFrom: 'mcp' }),
        makeDoctorSkill({ name: 'cloud', loadedFrom: 'syncedSkills' }),
        makeDoctorSkill({ name: 'well-used' }),
      ],
      {
        usageLookup: name => (name === 'well-used' ? used(2, 1) : undefined),
        now: NOW,
      },
    )
    expect(report.unusedOwned.map(r => r.name)).toEqual(['owned'])
    expect(report.unusedFromPlugins.map(r => r.name)).toEqual(['from-plugin'])
    expect(report.unusedFromMcp.map(r => r.name)).toEqual(['from-mcp'])
    expect(report.unusedSynced.map(r => r.name)).toEqual(['cloud'])
    // Used skills never leak into any unused bucket.
    for (const bucket of [
      report.unusedOwned,
      report.unusedFromPlugins,
      report.unusedFromMcp,
      report.unusedSynced,
    ]) {
      expect(bucket.map(r => r.name)).not.toContain('well-used')
    }
  })

  test('synced identifiers carry the synced-skill: prefix', () => {
    const report = runSkillDoctor(
      [makeDoctorSkill({ name: 'cloud', loadedFrom: 'syncedSkills' })],
      { usageLookup: () => undefined, now: NOW },
    )
    expect(report.rows[0]!.identifier).toBe(
      `${SYNCED_SKILL_PREFIX}userSettings:cloud`,
    )
    expect(report.unusedSynced).toHaveLength(1)
  })

  test('noUserSkills is true only for an empty registry', () => {
    expect(
      runSkillDoctor([], { usageLookup: () => undefined }).noUserSkills,
    ).toBe(true)
    expect(
      runSkillDoctor([makeDoctorSkill()], { usageLookup: () => undefined })
        .noUserSkills,
    ).toBe(false)
  })

  test('weekTokens is zero for skills unused inside the 7-day window', () => {
    const report = runSkillDoctor(
      [makeDoctorSkill({ name: 'stale' })],
      // last used 8 days ago — outside the window
      { usageLookup: () => used(5, 8), now: NOW },
    )
    expect(report.rows[0]!.usageCount).toBe(5)
    expect(report.rows[0]!.weekTokens).toBe(0)
  })

  test('weekTokensNote stays null on a healthy scan (R5 wiring)', () => {
    // R5: the anchor's scan-denied note was a hardcoded-null dead branch; it
    // now reports a failed usage-ledger read. With an injected lookup the
    // caller owns the ledger, so the healthy path keeps the note null (wire
    // format preserved for the W3 command shell).
    const report = runSkillDoctor([makeDoctorSkill()], {
      usageLookup: () => used(2, 1),
      now: NOW,
    })
    expect(report.weekTokensNote).toBeNull()
    expect(report.rows[0]!.usageCount).toBe(2)
  })

  test('weekTokensNote stays null on a healthy scan (R5 wiring: non-null now means ledger read failure)', () => {
    // With an injected lookup the caller owns the ledger — the anchor's
    // scan-denied note must stay null in the healthy path (wire format
    // preserved for the W3 command shell).
    const report = runSkillDoctor([makeDoctorSkill()], {
      usageLookup: () => used(2, 1),
      now: NOW,
    })
    expect(report.weekTokensNote).toBeNull()
    expect(report.rows[0]!.usageCount).toBe(2)
  })

  test('weekTokensNote stays null on a healthy scan (R5 wiring: non-null now means ledger read failure)', () => {
    // With an injected lookup the caller owns the ledger — the anchor's
    // scan-denied note must stay null in the healthy path (wire format
    // preserved for the W3 command shell).
    const report = runSkillDoctor([makeDoctorSkill()], {
      usageLookup: () => used(2, 1),
      now: NOW,
    })
    expect(report.weekTokensNote).toBeNull()
    expect(report.rows[0]!.usageCount).toBe(2)
  })

  test('weekTokensNote stays null on a healthy scan (R5 wiring: non-null now means ledger read failure)', () => {
    // With an injected lookup the caller owns the ledger — the anchor's
    // scan-denied note must stay null in the healthy path (wire format
    // preserved for the W3 command shell).
    const report = runSkillDoctor([makeDoctorSkill()], {
      usageLookup: () => used(2, 1),
      now: NOW,
    })
    expect(report.weekTokensNote).toBeNull()
    expect(report.rows[0]!.usageCount).toBe(2)
  })

  test('skips non-prompt commands and swallows throwing lookups', () => {
    const report = runSkillDoctor(
      [
        makeDoctorSkill({ type: 'local' }),
        makeDoctorSkill({ name: 'boom' }),
        makeDoctorSkill({ name: 'ok' }),
      ],
      {
        usageLookup: name => {
          if (name === 'boom') throw new Error('x')
          return undefined
        },
        now: NOW,
      },
    )
    expect(report.rows.map(r => r.name)).toEqual(['boom', 'ok'])
    expect(report.rows[0]!.usageCount).toBe(0)
  })

  test('often-unused rows sort last within rows ordering', () => {
    const report = runSkillDoctor(
      [
        makeDoctorSkill({ name: 'unused-a' }),
        makeDoctorSkill({ name: 'used' }),
      ],
      {
        usageLookup: name => (name === 'used' ? used(9, 0) : undefined),
        now: NOW,
      },
    )
    expect(report.rows.map(r => r.name)).toEqual(['used', 'unused-a'])
  })
})

describe('globalSkillUsageLookup', () => {
  test('reads the global-config skillUsage ledger', () => {
    // No usage recorded for unknown names in the default (empty) config env.
    expect(
      globalSkillUsageLookup('definitely-not-a-skill-name'),
    ).toBeUndefined()
  })
})

describe('createSkillDoctorEngine (W3 SkillDoctorEngine bridge)', () => {
  test('satisfies the command-shell interface (listSkillUsage)', () => {
    const engine = createSkillDoctorEngine(() => [
      makeDoctorSkill({ name: 'alpha' }),
    ])
    // Structural check against the W3 static interface shape.
    expect(typeof engine.listSkillUsage).toBe('function')
    expect(SKILL_DOCTOR_CATEGORIES.length).toBe(4)
  })

  test('flattens report rows into SkillUsageRecord shape', () => {
    const engine = createSkillDoctorEngine(
      () => [
        makeDoctorSkill({ name: 'fresh', loadedFrom: 'syncedSkills' }),
        makeDoctorSkill({ name: 'never' }),
      ],
      {
        usageLookup: name => (name === 'fresh' ? used(2, 1) : undefined),
        now: NOW,
      },
    )
    const records = engine.listSkillUsage()
    expect(records).toHaveLength(2)
    const fresh = records.find(r => r.name === 'fresh')!
    expect(fresh.invocations).toBe(2)
    expect(fresh.daysSinceUse).toBe(1)
    expect(fresh.source).toBe('userSettings')
    expect(fresh.tokenEstimate).toBeGreaterThan(0)
    const never = records.find(r => r.name === 'never')!
    expect(never.invocations).toBe(0)
    expect(never.daysSinceUse).toBeNull()
  })

  test('honours isEnabled on the source command', () => {
    const engine = createSkillDoctorEngine(() => [
      {
        ...makeDoctorSkill({ name: 'off' }),
        isEnabled: () => false,
      } as unknown as Command,
    ])
    const [record] = engine.listSkillUsage()
    expect(record!.name).toBe('off')
    expect(record!.enabled).toBe(false)
  })
})
