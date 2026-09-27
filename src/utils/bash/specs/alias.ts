import { t } from '../../../i18n/index.js';
import type { CommandSpec } from '../registry.js'

const alias: CommandSpec = {
  name: 'alias',
  description: t('Create or list command aliases'),
  args: {
    name: 'definition',
    description: t('Alias definition in the form name=value'),
    isOptional: true,
    isVariadic: true,
  },
}

export default alias
