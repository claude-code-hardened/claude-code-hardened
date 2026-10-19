import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const proTrialExpired = {
  type: 'local',
  name: 'pro-trial-expired',
  description: t(
    'Explain what changes when your Claude Pro trial ends and how to keep working',
  ),
  supportsNonInteractive: true,
  // Official isHidden semantics: not offered in the slash menu/typeahead —
  // upstream surfaces this copy only from the trial-expired context. It
  // stays invocable when typed explicitly or triggered by that context.
  isHidden: true,
  // Personal to the signed-in claude.ai subscriber account.
  availability: ['claude-ai'],
  load: () => import('./pro-trial-expired.js'),
} satisfies Command

export default proTrialExpired
