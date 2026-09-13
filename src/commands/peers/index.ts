import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const peers = {
  type: 'local',
  name: 'peers',
  aliases: ['who'],
  description: t('List connected Claude Code peers'),
  supportsNonInteractive: true,
  load: () => import('./peers.js'),
} satisfies Command

export default peers
