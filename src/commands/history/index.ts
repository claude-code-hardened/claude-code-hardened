import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const history = {
  type: 'local',
  name: 'history',
  aliases: ['hist'],
  description: t('View session history of a connected sub CLI'),
  supportsNonInteractive: false,
  load: () => import('./history.js'),
} satisfies Command

export default history
