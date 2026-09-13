import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const attach = {
  type: 'local',
  name: 'attach',
  description: t('Attach to a sub Claude CLI instance via named pipe'),
  supportsNonInteractive: false,
  load: () => import('./attach.js'),
} satisfies Command

export default attach
