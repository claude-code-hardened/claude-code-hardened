import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const fork = {
  type: 'local-jsx',
  name: 'fork',
  description: t('Fork the current session into a new sub-agent'),
  argumentHint: '<prompt>',
  load: () => import('./fork.js'),
} satisfies Command

export default fork
