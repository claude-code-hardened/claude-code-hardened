import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const agents = {
  type: 'local-jsx',
  name: 'agents',
  description: t('Manage agent configurations'),
  load: () => import('./agents.js'),
} satisfies Command

export default agents
