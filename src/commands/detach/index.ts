import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const detach = {
  type: 'local',
  name: 'detach',
  description: t('Detach from a sub CLI (or all connected subs)'),
  supportsNonInteractive: false,
  load: () => import('./detach.js'),
} satisfies Command

export default detach
