import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const releaseNotes: Command = {
  description: t('View release notes'),
  name: 'release-notes',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('./release-notes.js'),
}

export default releaseNotes
