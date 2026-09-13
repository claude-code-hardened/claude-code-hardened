import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const exit = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: t('Exit the REPL'),
  immediate: true,
  load: () => import('./exit.js'),
} satisfies Command

export default exit
