/**
 * Copy command - minimal metadata only.
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 */
import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description: t(
    "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
  ),
  load: () => import('./copy.js'),
} satisfies Command

export default copy
