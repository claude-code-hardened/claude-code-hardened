import { t } from '../../../i18n/index.js';
import type { CommandSpec } from '../registry.js'

const timeout: CommandSpec = {
  name: 'timeout',
  description: t('Run a command with a time limit'),
  args: [
    {
      name: 'duration',
      description: 'Duration to wait before timing out (e.g., 10, 5s, 2m)',
      isOptional: false,
    },
    {
      name: 'command',
      description: t('Command to run'),
      isCommand: true,
    },
  ],
}

export default timeout
