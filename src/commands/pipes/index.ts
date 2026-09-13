import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const pipes = {
  type: 'local',
  name: 'pipes',
  description: t('Inspect pipe registry state and toggle the pipe selector'),
  supportsNonInteractive: true,
  load: () => import('./pipes.js'),
} satisfies Command

export default pipes
