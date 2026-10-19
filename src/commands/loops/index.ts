import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const loops = {
  type: 'local',
  name: 'loops',
  description: t('List, create, and delete loop records'),
  argumentHint: '[list | create @every <n><s|m|h|d> <prompt> | delete <id>]',
  supportsNonInteractive: true,
  // Upstream ships /loops disabled (isEnabled: () => !1) and this build has
  // no loop scheduler wired — the command stays recording-only. Keep the
  // definition and code so records and tests survive, but match the official
  // disabled state instead of advertising a schedule that never fires.
  isEnabled: () => false,
  load: () => import('./loops.js'),
} satisfies Command

export default loops
