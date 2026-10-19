import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const reloadSkills = {
  type: 'local',
  name: 'reload-skills',
  description: t('Pick up skills added or changed on disk during this session'),
  supportsNonInteractive: true,
  load: () => import('./reload-skills.js'),
} satisfies Command

export default reloadSkills
