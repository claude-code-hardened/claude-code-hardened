import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const usageCredits = {
  type: 'local',
  name: 'usage-credits',
  description: t(
    'Configure usage credits or request them from your admin when you hit a limit',
  ),
  argumentHint: '[request]',
  supportsNonInteractive: true,
  load: () => import('./usage-credits.js'),
} satisfies Command

export default usageCredits
