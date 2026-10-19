import type { Command } from '../../commands.js'
import { t } from '../../i18n/index.js'

/**
 * /skills-dashboard — registration entry for the skills health panel
 * (upstream anchor 0025 module-003 :915). W5 (#56) owns this component side;
 * the one-line command-registry hook is command-domain:
 *
 *   const skillsDashboard = lazyCommand(() =>
 *     require('./components/SkillsDashboard/index.js'),
 *   )
 *   // then push `skillsDashboard` into the command list in src/commands.ts
 *
 * The definition sits beside its renderer so wiring needs no engine work,
 * mirroring src/commands/skills/index.ts.
 */
const skillsDashboard = {
  type: 'local-jsx',
  name: 'skills-dashboard',
  description: t('Show loaded skills and claude.ai sync health'),
  load: () => import('./skills-dashboard.js'),
} satisfies Command

export default skillsDashboard
