import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const cloudPlugins = {
  type: 'local',
  name: 'cloud-plugins',
  description: t(
    'Choose whether cloud sessions use the plugins enabled on this machine',
  ),
  argumentHint: '[on | off | status]',
  supportsNonInteractive: true,
  load: () => import('./cloud-plugins.js'),
} satisfies Command

export default cloudPlugins
