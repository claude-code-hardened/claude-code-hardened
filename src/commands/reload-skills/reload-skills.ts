import type { LocalCommandCall } from '../../types/command.js'
import { RELOAD_SKILLS_USAGE, parseReloadSkillsArgs } from './args.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getSkillDirCommands } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import { notifySkillsChanged } from '../../utils/skills/skillChangeDetector.js'
import { clearCommandsCache } from '../../commands.js'
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
      // Forget the ENTIRE loading pipeline, not just the inner memo — the
      // pre-fix half-no-op cleared only clearSkillCaches(), so the memoized
      // outer layers (loadAllCommands / getSkillToolCommands / the skill
      // index built on top) kept serving the stale list while the command
      // already claimed "N skills now active". Mirror the watcher reload
      // sequence (skillChangeDetector scheduleReload): clearCommandsCache
      // (which subsumes clearSkillCaches — plugin commands, plugin skills,
      // skill-dir caches, memoization) + resetSentSkillNames + skillsChanged.
      clearCommandsCache()
      resetSentSkillNames()
      notifySkillsChanged()
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
