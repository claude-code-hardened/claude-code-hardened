import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: t('Manage allow & deny tool permission rules'),
  load: () => import('./permissions.js'),
} satisfies Command

export default permissions
