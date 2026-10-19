import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const designLogin = {
  type: 'local',
  name: 'design-login',
  description: t('Record a design session connection on this machine'),
  argumentHint: '[connect | status]',
  supportsNonInteractive: true,
  load: () => import('./design-login.js'),
} satisfies Command

export default designLogin
