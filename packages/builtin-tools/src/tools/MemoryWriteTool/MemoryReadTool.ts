import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { MAX_MEMORY_READ_BYTES, MEMORY_READ_TOOL_NAME } from './constants.js'
import {
  getDefaultStoreName,
  isValidMemoryStoreName,
  readMemoryDocBounded,
  resolveMemoryEntryPath,
} from './store.js'
import { renderMemoryReadResult, renderToolUseMessage } from './UI.js'

// ── Schemas ──────────────────────────────────────────────────────────────────

const STORE_REGEX_STRING = '^(?!\\.)[^/\\\\:\\x00]{1,255}$'
const PATH_REGEX_STRING =
  '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*\\.md$'

const inputSchema = lazySchema(() =>
  z.strictObject({
    store: z
      .string()
      .regex(new RegExp(STORE_REGEX_STRING))
      .optional()
      .describe(
        'Memory store name. Defaults to the project-scoped store derived from the current project directory.',
      ),
    path: z
      .string()
      .regex(new RegExp(PATH_REGEX_STRING))
      .max(256)
      .describe(
        'Relative document path ending in .md, as returned by memory_list.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    store: z.string().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MemoryReadTool = buildTool({
  name: MEMORY_READ_TOOL_NAME,
  searchHint: 'read one saved memory document by path',
  userFacingName: () => 'Memory Read',
  maxResultSizeChars: MAX_MEMORY_READ_BYTES,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `read ${input.store ?? ''}:${input.path ?? ''}`
  },
  async description() {
    return 'Read a single memory document (frontmatter + markdown body) from the project memory store.'
  },
  async prompt() {
    return 'Read one memory document by relative .md path. Store defaults to the project-scoped store. Content is capped at 50KB and flagged truncated beyond that.'
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
      // Throws on traversal / missing store / symlink escape — caught below.
      let target: string
      try {
        const resolved = resolveMemoryEntryPath(store, input.path)
        target = resolved.target
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (message.includes('not found')) {
          return {
            data: {
              store,
              path: input.path,
              error: `Memory document '${store}/${input.path}' not found`,
            },
          }
        }
        throw e
      }
      const bounded = readMemoryDocBounded(target, MAX_MEMORY_READ_BYTES)
      if (bounded === null) {
        return {
          data: {
            store,
            path: input.path,
            error: `Memory document '${store}/${input.path}' not found`,
          },
        }
      }
      const out: Output = {
        store,
        path: input.path,
        content: bounded.value,
      }
      if (bounded.truncated) out.truncated = true
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
    return renderToolUseMessage('read', input, options)
  },
  renderToolResultMessage(output, progressMessages, options) {
    return renderMemoryReadResult(
      output as unknown as Parameters<typeof renderMemoryReadResult>[0],
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
