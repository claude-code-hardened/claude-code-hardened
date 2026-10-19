import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const alias = {
  type: 'local',
  name: 'alias',
  description: t('Create or list command aliases'),
  argumentHint: '[name=value | -d name | list]',
  supportsNonInteractive: true,
  load: () => import('./alias.js'),
} satisfies Command

export default alias
