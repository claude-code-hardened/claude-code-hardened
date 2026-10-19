import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const autoModeSetup = {
  type: 'local',
  name: 'auto-mode-setup',
  description: t('Record that agent auto mode has been set up on this machine'),
  argumentHint: '[enable | disable | status]',
  supportsNonInteractive: true,
  load: () => import('./auto-mode-setup.js'),
} satisfies Command

export default autoModeSetup
