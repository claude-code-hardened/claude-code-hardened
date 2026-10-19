import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'
import type { Command } from '../../../types/command.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
// SKILLS_SYNC default OFF — cloud health must stay null in these tests.
mock.module('bun:bundle', () => ({ feature: () => false }))

interface SkillOverrides {
  name?: string
  source?: string
  loadedFrom?: string
  description?: string
  userFacingName?: () => string
  argumentHint?: string
  type?: 'prompt' | 'local' | 'local-jsx'
}

// Test-fixture mock data; the loose factory shape is cast at the boundary.
function makeSkill(overrides: SkillOverrides = {}): Command {
  return {
    type: overrides.type ?? 'prompt',
    name: overrides.name ?? 'weather',
    description: overrides.description ?? 'test skill',
    progressMessage: 'running',
    contentLength: 10,
    source: overrides.source ?? 'userSettings',
    loadedFrom: overrides.loadedFrom,
    argumentHint: overrides.argumentHint,
    userFacingName: overrides.userFacingName,
    getPromptForCommand: async () => [],
  } as unknown as Command
}

const { buildDashboardRows } = await import('../useSkillsDashboard.js')
const { SKILL_IDENTIFIER_PREFIX } = await import(
  '../../../skills/syncedSkills.js'
)

describe('buildDashboardRows', () => {
  test('maps prompt skills to render rows with stable identifiers', () => {
    const rows = buildDashboardRows([
      makeSkill({ name: 'alpha', description: 'A skill' }),
    ])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.identifier).toBe(`${SKILL_IDENTIFIER_PREFIX}userSettings:alpha`)
    expect(row.name).toBe('alpha')
    expect(row.displayName).toBe('alpha')
    expect(row.source).toBe('userSettings')
    expect(row.loadedFrom).toBe('skills')
    expect(row.description).toBe('A skill')
    expect(row.contextTokens).toBeGreaterThan(0)
    expect(row.health).toBeNull()
  })

  test('skips non-prompt commands', () => {
    const rows = buildDashboardRows([
      makeSkill({ type: 'local' }),
      makeSkill({ name: 'real' }),
    ])
    expect(rows.map(r => r.name)).toEqual(['real'])
  })

  test('merges cloud health by skill name (SKILLS_SYNC on deployments)', () => {
    const rows = buildDashboardRows(
      [
        makeSkill({ name: 'healthy' }),
        makeSkill({ name: 'degraded' }),
        makeSkill({ name: 'unknown' }),
      ],
      new Map([
        ['healthy', 'ok'],
        ['degraded', 'stale'],
      ]),
    )
    // Rows sort by name (degraded < healthy < unknown).
    expect(rows.map(r => r.health)).toEqual(['stale', 'ok', null])
  })

  test('sorts rows by name', () => {
    const rows = buildDashboardRows([
      makeSkill({ name: 'zeta' }),
      makeSkill({ name: 'beta' }),
      makeSkill({ name: 'gamma' }),
    ])
    expect(rows.map(r => r.name)).toEqual(['beta', 'gamma', 'zeta'])
  })

  test('displayName honours userFacingName override', () => {
    const rows = buildDashboardRows([
      makeSkill({ name: 'alpha', userFacingName: () => 'Alpha!' }),
    ])
    expect(rows[0]!.displayName).toBe('Alpha!')
  })
})
