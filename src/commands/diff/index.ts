import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description: t('View uncommitted changes and per-turn diffs'),
  load: () => import('./diff.js'),
} satisfies Command
