/**
 * W5 (#55 R2) — accepted-ids model tests for the synced-skills surface.
 *
 * The model is a verbatim port of the official Rl/Zu pair (anchor
 * docs/reverse-284/decompiled/0025-chunk-m7ywx1p7/module-003-uncategorized.js,
 * functions Rl(a,h) and Zu(a,h,k) at Br/Ju definitions):
 *   Rl — a synced id not yet accepted migrates in when one of its alias
 *        expansions (Ju) is already accepted AND that alias is not occupied
 *        by a local (non-synced) skill id.
 *   Zu — toggle: not effectively-marked → add; effectively-marked → remove
 *        the id and its alias expansions, except an alias a local skill
 *        occupies (local + synced different-id co-existence).
 *
 * Persistence rides getClaudeConfigHomeDir()/synced-skills-accepted.json
 * (CLAUDE_CONFIG_DIR temp override per test). Pure-function tests run without
 * disk; the persistence tests set CLAUDE_CONFIG_DIR before importing
 * envUtils (its memoization caches per env value, so each new temp dir
 * recomputes).
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  ACCEPTED_SKILL_IDS_FILENAME,
  computeEffectiveAcceptedSkillIds,
  getAcceptedSkillIdsPath,
  readAcceptedSkillIds,
  toggleAcceptedSkillId,
  writeAcceptedSkillIdsSync,
} from '../syncedSkills.js'

function synced(name: string, source = 'claude.ai') {
  return { name, source, loadedFrom: 'syncedSkills' }
}
function local(name: string, source = 'project') {
  return { name, source }
}

describe('computeEffectiveAcceptedSkillIds (anchor Rl)', () => {
  test('unknown synced id does not appear without an accepted alias', () => {
    const effective = computeEffectiveAcceptedSkillIds(
      new Set(['skill:project:foo']),
      [synced('docs'), local('foo')],
    )
    expect(effective.has('synced-skill:claude.ai:docs')).toBe(false)
  })

  test('alias acceptance migrates the synced id in (non-mutating)', () => {
    const accepted = new Set(['skill:claude.ai:docs'])
    const effective = computeEffectiveAcceptedSkillIds(accepted, [
      synced('docs'),
    ])
    expect(effective.has('synced-skill:claude.ai:docs')).toBe(true)
    // original set untouched
    expect(accepted.has('synced-skill:claude.ai:docs')).toBe(false)
  })

  test('a local skill occupying the alias blocks the migration', () => {
    const accepted = new Set(['skill:project:docs'])
    const effective = computeEffectiveAcceptedSkillIds(accepted, [
      synced('docs'),
      local('docs'),
    ])
    // The alias id is occupied by the LOCAL skill — the synced id is NOT
    // migrated (official `!k.has(R)` guard); both ids can co-exist as
    // distinct entries.
    expect(effective.has('synced-skill:claude.ai:docs')).toBe(false)
  })
})

describe('toggleAcceptedSkillId (anchor Zu)', () => {
  test('toggle-on adds the id; toggle-off removes id and its aliases', () => {
    const skills = [synced('docs')]
    const accepted = new Set<string>()
    const on = toggleAcceptedSkillId(
      accepted,
      'synced-skill:claude.ai:docs',
      skills,
    )
    expect(on.has('synced-skill:claude.ai:docs')).toBe(true)
    const off = toggleAcceptedSkillId(on, 'synced-skill:claude.ai:docs', skills)
    expect(off.has('synced-skill:claude.ai:docs')).toBe(false)
    expect(off.has('skill:claude.ai:docs')).toBe(false)
  })

  test('migrated acceptance toggles off through the alias path', () => {
    const skills = [synced('docs')]
    // Only the legacy alias is stored; Rl makes the synced id effective.
    const stored = new Set(['skill:claude.ai:docs'])
    // Effective says accepted → toggling turns it OFF and scrubs the alias.
    const next = toggleAcceptedSkillId(
      stored,
      'synced-skill:claude.ai:docs',
      skills,
    )
    expect(next.has('synced-skill:claude.ai:docs')).toBe(false)
    expect(next.has('skill:claude.ai:docs')).toBe(false)
    expect(next.size).toBe(0)
  })

  test('toggle-off keeps an alias occupied by a local skill (co-existence)', () => {
    const skills = [synced('docs'), local('docs')]
    const stored = new Set([
      'synced-skill:claude.ai:docs',
      'skill:project:docs',
    ])
    const next = toggleAcceptedSkillId(
      stored,
      'synced-skill:claude.ai:docs',
      skills,
    )
    // The synced id is removed, but the LOCAL skill's id survives — the
    // alias deletion is blocked by the local occupant.
    expect(next.has('synced-skill:claude.ai:docs')).toBe(false)
    expect(next.has('skill:project:docs')).toBe(true)
  })
})

describe('accepted-ids persistence (synced-skills-accepted.json)', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'cch-synced-skills-'))

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  test('round-trips the id set with metadata', async () => {
    const ids = new Set(['synced-skill:claude.ai:docs', 'skill:project:foo'])
    writeAcceptedSkillIdsSync(ids)
    const raw = JSON.parse(
      readFileSync(getAcceptedSkillIdsPath(), 'utf-8'),
    ) as { version?: number; savedAt?: string; ids: string[] }
    expect(raw.ids.sort()).toEqual(
      ['skill:project:foo', 'synced-skill:claude.ai:docs'].sort(),
    )
    expect(raw.version).toBe(1)
    expect(typeof raw.savedAt).toBe('string')
    const readBack = await readAcceptedSkillIds()
    expect(readBack).toEqual(ids)
  })

  test('missing file degrades to an empty set', async () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(
      join(tmpdir(), 'cch-synced-skills-empty-'),
    )
    expect(await readAcceptedSkillIds()).toEqual(new Set())
  })

  test('malformed payload degrades to an empty set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cch-synced-skills-bad-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    writeAcceptedSkillIdsSync(new Set(['skill:project:foo']))
    const fs = await import('fs')
    fs.writeFileSync(
      join(dir, ACCEPTED_SKILL_IDS_FILENAME),
      '{"ids": "not-an-array"}',
    )
    expect(await readAcceptedSkillIds()).toEqual(new Set())
  })
})
