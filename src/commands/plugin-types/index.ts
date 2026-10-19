import { t } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const pluginTypes = {
  type: 'local',
  name: 'plugin-types',
  description: t(
    "Write claude-code.d.ts, claude-code-plugins.d.ts and claude-code-mcp.d.ts: the plugin API's TypeScript declarations, the enabled plugins' type contracts and the inputs of the connected MCP tools, for typing a hooks module against this session",
  ),
  argumentHint: '[output-dir]',
  supportsNonInteractive: true,
  load: () => import('./plugin-types.js'),
} satisfies Command

export default pluginTypes
