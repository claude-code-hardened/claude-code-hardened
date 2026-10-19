import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'
import type { Command, PromptCommand } from '../../types/command.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
// SKILLS_SYNC is not in any default feature list — assert the OFF default.
mock.module('bun:bundle', () => ({ feature: () => false }))

const synced = await import('../syncedSkills.js')
const SKILL_PREFIX = synced.SKILL_IDENTIFIER_PREFIX
const SYNCED_PREFIX = synced.SYNCED_SKILL_PREFIX

interface SkillOverrides {
  name?: string
  source?: string
  loadedFrom?: string
}

// Test-fixture mock data; the loose factory shape is cast at the boundary.
// Return type is the prompt branch of the Command union — `source` only
// exists on PromptCommand, so the plain union is not assignable to
// SkillIdentifierInput.
function makePromptSkill(
  overrides: SkillOverrides = {},
): Command & PromptCommand {
  return {
    type: 'prompt',
    name: overrides.name ?? 'weather',
    description: 'test skill',
    progressMessage: 'running',
    contentLength: 10,
    source: overrides.source ?? 'userSettings',
    loadedFrom: overrides.loadedFrom,
    getPromptForCommand: async () => [],
  } as unknown as Command & PromptCommand
}

describe('buildSkillIdentifier (anchor Br)', () => {
  test('synced skills use the synced-skill: prefix', () => {
    expect(
      synced.buildSkillIdentifier(
        makePromptSkill({ loadedFrom: 'syncedSkills' }),
      ),
    ).toBe(`${SYNCED_PREFIX}userSettings:weather`)
  })

  test('local skills keep the plain skill: prefix', () => {
    expect(synced.buildSkillIdentifier(makePromptSkill())).toBe(
      `${SKILL_PREFIX}userSettings:weather`,
    )
  })

  test('processed by parseSkillIdentifier round-trip', () => {
    const id = synced.buildSkillIdentifier(
      makePromptSkill({ loadedFrom: 'syncedSkills' }),
    )
    const parsed = synced.parseSkillIdentifier(id)
    expect(parsed).toEqual({
      prefix: SYNCED_PREFIX,
      source: 'userSettings',
      name: 'weather',
    })
  })

  test('parseSkillIdentifier rejects malformed identifiers', () => {
    expect(synced.parseSkillIdentifier('weather')).toBeNull()
  })
})

describe('getSkillIdentifierAliases (anchor Ju)', () => {
  test('name is case-normalized, source stays verbatim (R5 correction)', () => {
    expect(
      synced.getSkillIdentifierAliases(`${SYNCED_PREFIX}ClaudeAI:Weather`),
    ).toEqual([
      // Official Ju: ONLY the name segment is lowercased; the source keeps
      // its original casing.
      `${SYNCED_PREFIX}ClaudeAI:weather`,
      `${SKILL_PREFIX}ClaudeAI:weather`,
    ])
  })

  test('non-synced identifiers have no aliases', () => {
    expect(synced.getSkillIdentifierAliases(`${SKILL_PREFIX}user:w`)).toEqual(
      [],
    )
    expect(synced.getSkillIdentifierAliases('not-an-identifier')).toEqual([])
  })
})

describe('dedupeSyncedSkills (anchor Rl — local wins)', () => {
  test('keeps synced skills that collide with nothing local', () => {
    const kept = synced.dedupeSyncedSkills(
      [makePromptSkill({ name: 'cloud-only', loadedFrom: 'syncedSkills' })],
      [makePromptSkill({ name: 'local-thing' })],
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].name).toBe('cloud-only')
  })

  test('drops synced skills whose plain name is already loaded locally', () => {
    const kept = synced.dedupeSyncedSkills(
      [makePromptSkill({ name: 'weather', loadedFrom: 'syncedSkills' })],
      [makePromptSkill({ name: 'weather', source: 'projectSettings' })],
    )
    expect(kept).toHaveLength(0)
  })

  test('name collision and non-prompt entries are filtered', () => {
    const kept = synced.dedupeSyncedSkills(
      [
        makePromptSkill({ name: 'weather', loadedFrom: 'syncedSkills' }),
        makePromptSkill({
          name: 'weather2',
          source: 'projectSettings',
          loadedFrom: 'syncedSkills',
        }),
        // stray non-prompt command
        {
          type: 'local' as const,
          name: 'broken',
          supportsNonInteractive: true,
          load: async () => ({
            call: async () => ({ type: 'text' as const, value: '' }),
          }),
        } as unknown as Command,
      ],
      // local skill with the same identifier (skill:projectSettings:weather2)
      [makePromptSkill({ name: 'weather2', source: 'projectSettings' })],
    )
    // 'weather' collides with nothing; 'weather2' hits the name/identifier
    // collision; the local command is never a synced candidate.
    expect(kept.map(s => s.name)).toEqual(['weather'])
  })

  test('mergeSkillRegistry preserves local-first order', () => {
    const local = [
      makePromptSkill({ name: 'alpha' }),
      makePromptSkill({ name: 'beta', source: 'projectSettings' }),
    ]
    const syncedSkills = [
      makePromptSkill({ name: 'gamma', loadedFrom: 'syncedSkills' }),
      makePromptSkill({ name: 'alpha', loadedFrom: 'syncedSkills' }),
    ]
    const merged = synced.mergeSkillRegistry(local, syncedSkills)
    expect(merged.map(c => c.name)).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('cloud face — SKILLS_SYNC feature gate (default OFF)', () => {
  test('isSkillsSyncEnabled is false without the build feature', () => {
    expect(synced.isSkillsSyncEnabled()).toBe(false)
  })

  test('fetchSkillHealthIfEnabled is a no-op when the gate is closed', async () => {
    const health = await synced.fetchSkillHealthIfEnabled({
      fetchImpl: (() => {
        throw new Error('network must not be touched with SKILLS_SYNC off')
      }) as unknown as typeof fetch,
    })
    expect(health.size).toBe(0)
  })
})

describe('getSkillsApiBase', () => {
  test('defaults to claude.ai', () => {
    expect(synced.getSkillsApiBase()).toBe('https://claude.ai')
  })

  test('env override trims trailing slashes', () => {
    const prev = process.env[synced.SKILLS_API_BASE_ENV]
    try {
      process.env[synced.SKILLS_API_BASE_ENV] = 'https://proxy.example.com/api/'
      expect(synced.getSkillsApiBase()).toBe('https://proxy.example.com/api')
    } finally {
      if (prev === undefined) delete process.env[synced.SKILLS_API_BASE_ENV]
      else process.env[synced.SKILLS_API_BASE_ENV] = prev
    }
  })
})
