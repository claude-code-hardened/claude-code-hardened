import { describe, expect, test } from 'bun:test'

import { BRIDGE_SAFE_COMMANDS, REMOTE_SAFE_COMMANDS } from '../commands.js'
import clear from '../commands/clear/index.js'
import compact from '../commands/compact/index.js'
import usage from '../commands/usage/index.js'
import {
  clearBundledSkills,
  getBundledSkills,
  registerBundledSkill,
  type BundledSkillDefinition,
} from '../skills/bundledSkills.js'

/**
 * Behavior contracts around the startup-lazy command design that the
 * getCommands early-kick (main.tsx) relies on. Kept hermetic on purpose:
 * calling getCommands()/forceLoadAllShims() here would load every command
 * module and env-sensitive dependency at module scope, polluting sibling
 * test files in the same process (bun mock.module / module singletons are
 * process-global — see CLAUDE.md). The full-shim load contract is covered by
 * the compiled-binary smoke (`claude --check-commands`) in CI's package job.
 *
 * - Identity sets (REMOTE_SAFE_COMMANDS / BRIDGE_SAFE_COMMANDS) rely on
 *   object identity between the statically imported command modules and the
 *   objects returned by getCommands(). A shim that resolved to a copy would
 *   silently break filterCommandsForRemoteMode / isBridgeSafeCommand.
 * - Bundled skills must be registered before the first loadAllCommands run:
 *   the loader memoizes per cwd, so a late registration would leave the
 *   memoized list without bundled skills (the startup race the main.tsx
 *   registration-before-kick ordering exists to prevent).
 */
describe('startup-lazy command safe sets', () => {
  test('statically imported command modules keep their identity in the safe sets', () => {
    expect(REMOTE_SAFE_COMMANDS.has(clear)).toBe(true)
    expect(BRIDGE_SAFE_COMMANDS.has(compact)).toBe(true)
    expect(BRIDGE_SAFE_COMMANDS.has(usage)).toBe(true)
  })

  test('safe-set members are real Commands with string names', () => {
    for (const cmd of REMOTE_SAFE_COMMANDS) {
      if (!cmd) continue // feature-gated members may be null in this runtime
      expect(typeof cmd.name).toBe('string')
    }
    for (const cmd of BRIDGE_SAFE_COMMANDS) {
      expect(typeof cmd.name).toBe('string')
    }
  })
})

describe('bundled skills registry', () => {
  const fakeSkill = (name: string): BundledSkillDefinition =>
    ({
      name,
      description: `test skill ${name}`,
      getPromptForCommand: async () => [],
    }) as unknown as BundledSkillDefinition

  test('registerBundledSkill appends and getBundledSkills returns a copy', () => {
    clearBundledSkills()
    registerBundledSkill(fakeSkill('startup-lazy-sentinel-a'))
    const skills = getBundledSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('startup-lazy-sentinel-a')
    // Mutating the returned array must not affect the registry.
    skills.push({ name: 'mutated' } as never)
    expect(getBundledSkills()).toHaveLength(1)
  })

  test('registering the same name twice appends twice (no dedupe)', () => {
    clearBundledSkills()
    registerBundledSkill(fakeSkill('startup-lazy-sentinel-b'))
    registerBundledSkill(fakeSkill('startup-lazy-sentinel-b'))
    const skills = getBundledSkills()
    expect(skills.map(s => s.name)).toEqual([
      'startup-lazy-sentinel-b',
      'startup-lazy-sentinel-b',
    ])
    clearBundledSkills()
    expect(getBundledSkills()).toHaveLength(0)
  })
})
