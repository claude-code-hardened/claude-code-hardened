import { t } from '../../../i18n/index.js';
import type { CommandSpec } from '../registry.js'

const time: CommandSpec = {
  name: 'time',
  description: t('Time a command'),
  args: {
    name: 'command',
    description: t('Command to time'),
    isCommand: true,
  },
}

export default time
