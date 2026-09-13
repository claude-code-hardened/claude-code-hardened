import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const theme = {
  type: 'local-jsx',
  name: 'theme',
  description: t('Change the theme'),
  load: () => import('./theme.js'),
} satisfies Command

export default theme
