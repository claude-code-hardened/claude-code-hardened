/**
 * W3 task #54 — /plugin-types: write the plugin API TypeScript declaration
 * skeletons (claude-code.d.ts, claude-code-plugins.d.ts, claude-code-mcp.d.ts)
 * for typing a hooks module against this session.
 *
 * Upstream generates these from live session state (enabled plugins, connected
 * MCP tools). This W3 skeleton emits the declaration headers from the official
 * anchor with placeholder bodies; the live type-contract emission is later
 * work (plugin system deep-dive).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import { PLUGIN_TYPES_USAGE, parsePluginTypesArgs } from './args.js'

export const PLUGIN_TYPES_FILES: { fileName: string; header: string[] }[] = [
  {
    fileName: 'claude-code.d.ts',
    header: [
      "// claude-code.d.ts — the plugin API's TypeScript declarations.",
      '// For typing a hooks module against this session.',
    ],
  },
  {
    fileName: 'claude-code-plugins.d.ts',
    header: [
      "// claude-code-plugins.d.ts — the enabled plugins' type contracts.",
    ],
  },
  {
    fileName: 'claude-code-mcp.d.ts',
    header: [
      '// claude-code-mcp.d.ts — the inputs of the connected MCP tools.',
    ],
  },
]

function renderDeclaration(fileName: string): string {
  switch (fileName) {
    case 'claude-code.d.ts':
      return [
        ...PLUGIN_TYPES_FILES[0].header,
        '',
        'export interface HookInput {',
        '  session_id: string',
        '  transcript_path: string',
        '  cwd: string',
        '  hook_event_name: string',
        '}',
        '',
        'export interface HookOutput {',
        '  continue?: boolean',
        '  suppressOutput?: boolean',
        '  decision?: "approve" | "block"',
        '  reason?: string',
        '}',
        '',
      ].join('\n')
    case 'claude-code-plugins.d.ts':
      return [
        ...PLUGIN_TYPES_FILES[1].header,
        '',
        'export interface PluginTypeContract {',
        '  pluginName: string',
        '  commands: string[]',
        '  skills: string[]',
        '  mcpServers: string[]',
        '}',
        '',
      ].join('\n')
    default:
      return [
        ...PLUGIN_TYPES_FILES[2].header,
        '',
        'export interface McpToolInput {',
        '  tool: string',
        "  // JSON schema of the connected MCP tool's input.",
        '  inputSchema: Record<string, unknown>',
        '}',
        '',
      ].join('\n')
  }
}

export const call: LocalCommandCall = async rawArgs => {
  const args = parsePluginTypesArgs(rawArgs)
  switch (args.action) {
    case 'help':
      return { type: 'text', value: PLUGIN_TYPES_USAGE }
    case 'invalid':
      return {
        type: 'text',
        value: [args.error, '', PLUGIN_TYPES_USAGE].join('\n'),
      }
    case 'write': {
      const outDir = resolve(args.outputDir)
      mkdirSync(outDir, { recursive: true })
      const written = PLUGIN_TYPES_FILES.map(({ fileName }) => {
        const path = join(outDir, fileName)
        writeFileSync(path, renderDeclaration(fileName), 'utf8')
        return path
      })
      return {
        type: 'text',
        value: [
          'Wrote plugin declaration skeletons:',
          ...written.map(path => `  ${path}`),
          '',
          'Skeleton scope (W3): declaration headers only. Live emission of the',
          "enabled plugins' type contracts and MCP tool inputs is feature work on",
          'the plugin-system track.',
        ].join('\n'),
      }
    }
  }
}
