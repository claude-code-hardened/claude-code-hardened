import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const mode = {
  type: 'local-jsx',
  name: 'mode',
  description: t(
    'Switch interaction mode (default, gentle, sharp, workhorse, token-saver, super-ai)',
  ),
  isEnabled: () => true,
  argumentHint: '<mode-slug>',
  load: () => import('./mode.js'),
} satisfies Command

export default mode
