import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const skills = {
  type: 'local-jsx',
  name: 'skills',
  description: t('List available skills'),
  load: () => import('./skills.js'),
} satisfies Command

export default skills
