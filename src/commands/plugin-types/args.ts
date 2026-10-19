/**
 * W3 task #54 — /plugin-types argument parser. Pure module.
 */

export type PluginTypesArgs =
  | { action: 'write'; outputDir: string }
  | { action: 'help' }
  | { action: 'invalid'; error: string }

export const PLUGIN_TYPES_USAGE = [
  'Usage: /plugin-types [output-dir]',
  '',
  'Writes the plugin API TypeScript declaration skeletons:',
  '  claude-code.d.ts         — the plugin API declarations, for typing a hooks module against this session',
  "  claude-code-plugins.d.ts — the enabled plugins' type contracts",
  '  claude-code-mcp.d.ts     — the inputs of the connected MCP tools',
  '',
  'Defaults to .claude/plugin-types under the current working directory.',
].join('\n')

export const DEFAULT_PLUGIN_TYPES_OUTPUT_DIR = '.claude/plugin-types'

export function parsePluginTypesArgs(raw: string): PluginTypesArgs {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return { action: 'write', outputDir: DEFAULT_PLUGIN_TYPES_OUTPUT_DIR }
  }
  if (parts[0] === 'help') {
    return { action: 'help' }
  }
  if (parts.length > 1) {
    return {
      action: 'invalid',
      error: 'Expected at most one argument: the output directory',
    }
  }
  if (parts[0].startsWith('-')) {
    return { action: 'invalid', error: `Unknown option: "${parts[0]}"` }
  }
  return { action: 'write', outputDir: parts[0] }
}
