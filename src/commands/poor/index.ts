import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const poor = {
  type: 'local',
  name: 'poor',
  description: t(
    'Toggle poor mode — disable extract_memories and prompt_suggestion to save tokens',
  ),
  supportsNonInteractive: false,
  load: () => import('./poor.js'),
} satisfies Command

export default poor
