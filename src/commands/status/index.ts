import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description: t(
    'Show Claude Code status including version, model, account, API connectivity, and tool statuses',
  ),
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
