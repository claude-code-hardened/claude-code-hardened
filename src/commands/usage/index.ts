import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  aliases: ['cost', 'stats'],
  description: t('Show session cost, plan usage, and activity stats'),
  load: () => import('./usage.js'),
} satisfies Command
