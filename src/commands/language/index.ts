import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const language = {
  type: 'local-jsx',
  name: 'language',
  description: t('Set the UI display language'),
  load: () => import('./language.js'),
} satisfies Command

export default language
