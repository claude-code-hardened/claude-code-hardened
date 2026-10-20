import { describe, expect, test, mock } from 'bun:test'
import { RELOAD_SKILLS_USAGE, parseReloadSkillsArgs } from '../args.js'

// ── Full-invalidation wiring (item 3 — /reload-skills no longer a half no-op)
// … passthrough mocks: the real modules stay loaded and the stubs call
// through, so sibling test files in the same process keep their behavior —
// only the calls are counted here.
const invalidationCalls: string[] = []

const attachmentsReal = await import('src/utils/attachments.js')
const commandsReal = await import('src/commands.js')
const detectorReal = await import('src/utils/skills/skillChangeDetector.js')
// Direct references captured BEFORE mock.module — bun rewrites the loaded
// namespace in place, so calls must go through these snapshots to reach the
// real implementation (call-through keeps sibling behavior identical).
const realResetSentSkillNames = attachmentsReal.resetSentSkillNames
const realClearCommandsCache = commandsReal.clearCommandsCache
const realNotifySkillsChanged = detectorReal.notifySkillsChanged

mock.module('src/utils/attachments.js', () => ({
  ...attachmentsReal,
  resetSentSkillNames: () => {
    invalidationCalls.push('resetSentSkillNames')
    realResetSentSkillNames()
  },
}))
mock.module('src/commands.js', () => ({
  ...commandsReal,
  clearCommandsCache: () => {
    invalidationCalls.push('clearCommandsCache')
    realClearCommandsCache()
  },
}))
mock.module('src/utils/skills/skillChangeDetector.js', () => ({
  ...detectorReal,
  notifySkillsChanged: () => {
    invalidationCalls.push('notifySkillsChanged')
    realNotifySkillsChanged()
  },
}))

// Imported AFTER the mocks so the command binds the counting passthroughs.
const { call } = await import('../reload-skills.js')

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

describe('reload action — full invalidation pipeline (item 3)', () => {
  test('clears the whole command pipeline, resets sent-skill names, emits skillsChanged', async () => {
    invalidationCalls.length = 0
    const result = await call('', {
      options: { commands: [] },
    } as never)
    // The watcher-reload sequence (skillChangeDetector scheduleReload):
    // outer memo + plugin caches + skill-dir caches (clearCommandsCache,
    // which subsumes clearSkillCaches) → sent-skill dedup reset → signal.
    expect(invalidationCalls).toEqual([
      'clearCommandsCache',
      'resetSentSkillNames',
      'notifySkillsChanged',
    ])
    // The count is re-read from disk AFTER invalidation and echoed honestly.
    expect((result as { type: string }).type).toBe('text')
    expect(
      (result as { value: string }).value.startsWith(
        'Reloaded skills from disk: ',
      ),
    ).toBe(true)
    expect(
      /Reloaded skills from disk: \d+ (skill|skills) now active\.|Reloaded skills from disk: 0 found\./.test(
        (result as { value: string }).value,
      ),
    ).toBe(true)
  })
})
