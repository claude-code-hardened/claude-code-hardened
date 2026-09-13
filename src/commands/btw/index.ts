import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const btw = {
  type: 'local-jsx',
  name: 'btw',
  description: t(
    'Ask a quick side question without interrupting the main conversation',
  ),
  immediate: true,
  argumentHint: '<question>',
  load: () => import('./btw.js'),
} satisfies Command

export default btw
