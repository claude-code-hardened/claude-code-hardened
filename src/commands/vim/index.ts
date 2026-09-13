import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const command = {
  name: 'vim',
  description: t('Toggle between Vim and Normal editing modes'),
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./vim.js'),
} satisfies Command

export default command
