import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const focus = {
  type: 'local',
  name: 'focus',
  description: t(
    'Persist the focus view preference (prompt / summary / response only)',
  ),
  argumentHint: '[on | off | status]',
  supportsNonInteractive: true,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
