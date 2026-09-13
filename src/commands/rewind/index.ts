import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const rewind = {
  description: t(`Restore the code and/or conversation to a previous point`),
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind
