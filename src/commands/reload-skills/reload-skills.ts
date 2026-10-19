import type { LocalCommandCall } from '../../types/command.js'
import { RELOAD_SKILLS_USAGE, parseReloadSkillsArgs } from './args.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  clearSkillCaches,
  getSkillDirCommands,
} from '../../skills/loadSkillsDir.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async rawArgs => {
  const args = parseReloadSkillsArgs(rawArgs)
  switch (args.action) {
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', RELOAD_SKILLS_USAGE].join('\n'),
      }
    case 'help':
      return { type: 'text', value: RELOAD_SKILLS_USAGE }
    case 'reload': {
      // Forget every memoized skill-dir scan so the next load re-walks disk.
      clearSkillCaches()
      const skills = await getSkillDirCommands(getOriginalCwd())
      const count = skills.length
      return {
        type: 'text',
        value:
          count === 0
            ? 'Reloaded skills from disk: 0 found.'
            : `Reloaded skills from disk: ${count} ${plural(count, 'skill')} now active.`,
      }
    }
  }
}
