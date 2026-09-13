import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: t('Edit Claude memory files'),
  load: () => import('./memory.js'),
}

export default memory
