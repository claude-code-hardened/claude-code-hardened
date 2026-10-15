import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { MEMORY_LIST_TOOL_NAME, MAX_LIST_MEMORY_DOCS } from './constants.js'
import {
  getDefaultStoreName,
  isValidMemoryStoreName,
  listMemoryDocs,
} from './store.js'
import { renderMemoryListResult, renderToolUseMessage } from './UI.js'

// ── Schemas ──────────────────────────────────────────────────────────────────

const STORE_REGEX_STRING = '^(?!\\.)[^/\\\\:\\x00]{1,255}$'

interface DocMeta {
  path: string
  name: string
  type: string
  description?: string
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    store: z
      .string()
      .regex(new RegExp(STORE_REGEX_STRING))
      .optional()
      .describe(
        'Memory store name. Defaults to the project-scoped store derived from the current project directory.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    store: z.string().optional(),
    docs: z
      .array(
        z.object({
          path: z.string(),
          name: z.string(),
          type: z.string(),
          description: z.string().optional(),
        }),
      )
      .optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MemoryListTool = buildTool({
  name: MEMORY_LIST_TOOL_NAME,
  searchHint: 'list saved memory documents with names, descriptions and types',
  userFacingName: () => 'Memory List',
  maxResultSizeChars: MAX_LIST_MEMORY_DOCS * 64,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `list ${input.store ?? ''}`
  },
  async description() {
    return 'List memory documents in a store with their frontmatter name, description and type.'
  },
  async prompt() {
    return 'List saved memory documents (path, name, description, type) from the project memory store. Store defaults to the project-scoped store.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input: Input) {
    try {
      if (!isValidMemoryStoreName(input.store ?? '')) {
        return { data: { error: `Invalid store name: '${input.store}'` } }
      }
      const store = input.store ?? getDefaultStoreName()
      const result = listMemoryDocs(store)
      if (result === null) {
        const out: Output = { store, docs: [] }
        return { data: out }
      }
      const out: Output = {
        store,
        docs: result.docs,
      }
      if (result.truncated) out.truncated = true
      return { data: out }
    } catch (e) {
      return {
        data: {
          error: e instanceof Error ? e.message : String(e),
        },
      }
    }
  },
  renderToolUseMessage(input, options) {
    return renderToolUseMessage('list', input, options)
  },
  renderToolResultMessage(output, progressMessages, options) {
    return renderMemoryListResult(
      output as unknown as Parameters<typeof renderMemoryListResult>[0] & {
        docs?: DocMeta[]
      },
      progressMessages,
      options,
    )
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(output),
      is_error: output?.error !== undefined,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
