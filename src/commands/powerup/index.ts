import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const powerup = {
  type: 'local',
  name: 'powerup',
  description: t(
    'Show the step-by-step course checklist for getting more out of Claude Code',
  ),
  supportsNonInteractive: true,
  load: () => import('./powerup.js'),
} satisfies Command

export default powerup
