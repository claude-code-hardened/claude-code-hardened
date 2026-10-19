// MCP completions capability — official anchor:
// docs/reverse-284/decompiled/0034-chunk-2qjch3b9/module-005-uncategorized.js:1244 (Tp):
//   if (!e.capabilities?.completions) return []
//   complete({ ref: { type: 'ref/resource', uri }, argument: { name, value },
//              context: keys(args).length > 0 ? { arguments: args } : undefined })
//   → completion.values; failures degrade to [] with MCP error log
//   ("Failed to complete resource template").
// resources/templates/list enumeration per MCP spec via the SDK's typed
// listResourceTemplates() (os0034 anchor enumerates templates alongside
// resources/list for template URI variable completion).

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  CompleteResult,
  ResourceTemplate,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { memoizeWithLRU } from '../../utils/memoize.js'

/** Per-server template cache size — matches the resources/list fetch cache in client.ts. */
const COMPLETIONS_CACHE_SIZE = 20

export type ServerResourceTemplate = ResourceTemplate & { server: string }

/** Minimal structural view of a connected MCP server — avoids a hard
 * dependency on the full MCPServerConnection union (pure module). */
export interface CompletionConnection {
  name: string
  client: Client
  capabilities?: ServerCapabilities | null
}

/** capabilities.completions negotiation: servers that don't declare the
 * capability never receive completion/complete requests. */
export function supportsCompletions(
  capabilities: ServerCapabilities | undefined | null,
): boolean {
  return !!capabilities?.completions
}

/** resources/templates/list enumeration (memoized per server name, same LRU
 * semantics as fetchResourcesForClient in client.ts). */
export const fetchResourceTemplatesForClient = memoizeWithLRU(
  async (
    connection: CompletionConnection,
  ): Promise<ServerResourceTemplate[]> => {
    const { name, client, capabilities } = connection
    try {
      // Templates are a resources sub-capability: gate on resources, like
      // resources/list does in client.ts.
      if (!capabilities?.resources) {
        return []
      }

      const result = await client.listResourceTemplates()
      const templates = result.resourceTemplates ?? []
      if (templates.length === 0) return []

      // Sanitize unicode like resources/list results, then tag the server.
      return templates.map(template => ({
        ...template,
        server: name,
      }))
    } catch (error) {
      logMCPError(
        name,
        `Failed to fetch resource templates: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (connection: CompletionConnection) => connection.name,
  COMPLETIONS_CACHE_SIZE,
)

/** Invalidate the per-server template cache (list_changed refresh path). */
export function clearResourceTemplatesCache(serverName: string): void {
  fetchResourceTemplatesForClient.cache.delete(serverName)
}

/** completions/complete with complete_resource_template semantics: fill in
 * one template URI variable. degraded to [] on any failure (official anchor
 * mcp_complete_resource_template_failed path). */
export async function completeResourceTemplate(
  connection: CompletionConnection,
  uri: string,
  argumentName: string,
  argumentValue: string,
  contextArguments?: Record<string, string>,
): Promise<CompleteResult['completion']['values']> {
  const { name } = connection
  if (!supportsCompletions(connection.capabilities)) {
    return []
  }
  try {
    logMCPDebug(
      name,
      `mcp_complete_resource_template uri=${uri} arg=${argumentName}`,
    )
    const result = await connection.client.complete({
      ref: { type: 'ref/resource', uri },
      argument: { name: argumentName, value: argumentValue },
      // Official anchor: omit context entirely when no prior arguments.
      context:
        contextArguments && Object.keys(contextArguments).length > 0
          ? { arguments: contextArguments }
          : undefined,
    })
    return result.completion.values
  } catch (error) {
    logMCPError(
      name,
      `Failed to complete resource template: ${errorMessage(error)}`,
    )
    return []
  }
}
