import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: t('Show help and available commands'),
  load: () => import('./help.js'),
} satisfies Command

export default help
