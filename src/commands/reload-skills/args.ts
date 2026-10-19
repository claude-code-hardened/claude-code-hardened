/**
 * W3 task #54 — /reload-skills argument parser. Pure module. The upstream
 * command takes no arguments; anything provided is rejected with usage text.
 */

export type ReloadSkillsArgs =
  | { action: 'reload' }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const RELOAD_SKILLS_USAGE =
  'Usage: /reload-skills — rescan skill directories loaded into this session'

export function parseReloadSkillsArgs(raw: string): ReloadSkillsArgs {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return { action: 'reload' }
  if (trimmed === 'help') return { action: 'help' }
  return {
    action: 'invalid',
    error: `/reload-skills takes no arguments (got "${raw.trim()}")`,
  }
}
