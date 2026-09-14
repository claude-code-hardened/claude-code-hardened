import { describe, expect, test } from 'bun:test'

import {
  BRIDGE_SAFE_COMMANDS,
  REMOTE_SAFE_COMMANDS,
  forceLoadAllShims,
  getCommands,
} from '../commands.js'
import clear from '../commands/clear/index.js'
import compact from '../commands/compact/index.js'
import usage from '../commands/usage/index.js'
import { initBundledSkills } from '../skills/bundled/index.js'
import { clearBundledSkills, getBundledSkills } from '../skills/bundledSkills.js'

/**
 * Startup-lazy command shims: behavior contracts that must hold even though
 * most commands are Proxy shims deferred to first property access.
 *
 * - Identity sets (REMOTE_SAFE_COMMANDS / BRIDGE_SAFE_COMMANDS) rely on object
 *   identity between the statically imported command modules and the objects
 *   returned by getCommands(). A shim that resolved to a *copy* would silently
 *   break filterCommandsForRemoteMode / isBridgeSafeCommand.
 * - forceLoadAllShims() is the compile-smoke contract: every lazy thunk must
 *   resolve to a real Command (module present in the bundle).
 * - Bundled skills must be registered before the first getCommands() load:
 *   loadAllCommands memoizes per cwd, so a late registration would leave the
 *   memoized list without bundled skills (the startup race the main.tsx kick
 *   ordering exists to prevent).
 */
describe('startup-lazy command shims', () => {
  test('forceLoadAllShims resolves every shim to a Command with a string name', () => {
    expect(() => forceLoadAllShims()).not.toThrow()
  })

  test('REMOTE_SAFE_COMMANDS members are the same objects returned by getCommands', async () => {
    const commands = await getCommands(process.cwd())
    const byIdentity = new Set(commands)
    for (const safe of REMOTE_SAFE_COMMANDS) {
      // Feature-gated members (e.g. proactive under a disabled flag) are null
      // in the default test runtime — the Set intentionally contains them.
      if (!safe) continue
      expect(byIdentity.has(safe)).toBe(true)
    }
  })

  test('statically imported command modules keep their identity in the safe sets', () => {
    expect(REMOTE_SAFE_COMMANDS.has(clear)).toBe(true)
    expect(BRIDGE_SAFE_COMMANDS.has(compact)).toBe(true)
    expect(BRIDGE_SAFE_COMMANDS.has(usage)).toBe(true)
  })

  test('every non-null REMOTE_SAFE_COMMANDS member present by name matches by identity', async () => {
    const commands = await getCommands(process.cwd())
    let checked = 0
    for (const safe of REMOTE_SAFE_COMMANDS) {
      if (!safe) continue
      const match = commands.find(c => c.name === safe.name)
      if (!match) continue // disabled in this environment — hidden by the same production filter
      expect(match).toBe(safe)
      checked++
    }
    // The always-on local TUI commands must actually be present, otherwise
    // this test would silently assert nothing.
    expect(checked).toBeGreaterThan(3)
  })
})

describe('bundled skills registration before command load', () => {
  test('initBundledSkills registers a unique-named skill set', () => {
    clearBundledSkills()
    expect(getBundledSkills()).toHaveLength(0)
    initBundledSkills()
    const skills = getBundledSkills()
    expect(skills.length).toBeGreaterThan(0)
    expect(new Set(skills.map(s => s.name)).size).toBe(skills.length)
  })

  test('skills registered before a fresh getCommands load appear in the result', async () => {
    clearBundledSkills()
    initBundledSkills()
    const skills = getBundledSkills()
    // Unique cwd string → fresh loadAllCommands memoize entry → the loader
    // reads getBundledSkills() at resolve time, so the registrations above
    // must be visible (they always are when registration precedes the kick).
    const commands = await getCommands(
      '/nonexistent-claude-code-startup-lazy-test',
    )
    const byIdentity = new Set(commands)
    for (const skill of skills) {
      expect(byIdentity.has(skill)).toBe(true)
    }
  })
})
