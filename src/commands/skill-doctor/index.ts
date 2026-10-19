import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const skillDoctor = {
  type: 'local',
  name: 'skill-doctor',
  description: t('Show which loaded skills are unused and costing context'),
  argumentHint: '[demo]',
  supportsNonInteractive: true,
  load: () => import('./skill-doctor.js'),
} satisfies Command

export default skillDoctor
