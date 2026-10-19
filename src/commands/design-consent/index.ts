import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const designConsent = {
  type: 'local',
  name: 'design-consent',
  description: t(
    'Record whether design review sessions may read workspace files on this machine',
  ),
  argumentHint: '[grant | decline | status]',
  supportsNonInteractive: true,
  load: () => import('./design-consent.js'),
} satisfies Command

export default designConsent
