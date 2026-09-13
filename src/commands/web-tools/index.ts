import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const webTools = {
  type: 'local-jsx',
  name: 'web-tools',
  description: t('Configure web search and web fetch backends'),
  load: () => import('./web-tools.js'),
} satisfies Command

export default webTools
