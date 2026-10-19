import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const designRevoke = {
  type: 'local',
  name: 'design-revoke',
  description: t(
    'Revoke the design session connection recorded by /design-login',
  ),
  argumentHint: '[status]',
  supportsNonInteractive: true,
  load: () => import('./design-revoke.js'),
} satisfies Command

export default designRevoke
