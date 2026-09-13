import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const ide = {
  type: 'local-jsx',
  name: 'ide',
  description: t('Manage IDE integrations and show status'),
  argumentHint: '[open]',
  load: () => import('./ide.js'),
} satisfies Command

export default ide
