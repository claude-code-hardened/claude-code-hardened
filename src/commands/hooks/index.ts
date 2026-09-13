import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: t('View hook configurations for tool events'),
  immediate: true,
  load: () => import('./hooks.js'),
} satisfies Command

export default hooks
