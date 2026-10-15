import { z } from 'zod/v4'
import { existsSync } from 'node:fs'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { MAX_MEMORY_DOC_BYTES, MEMORY_WRITE_TOOL_NAME } from './constants.js'
import {
  getDefaultStoreName,
  isValidMemoryStoreName,
  resolveMemoryEntryPath,
  serializeMemoryDoc,
  writeFileAtomic,
} from './store.js'
import { renderMemoryWriteResult, renderToolUseMessage } from './UI.js'

// ── Schemas ──────────────────────────────────────────────────────────────────
//
// Wire name and semantics follow the official memory_write tool ("save a
// document to a memory store"): a relative `.md` path plus markdown content,
// stored as a frontmatter-carrying document in the (project-scoped, env-
// overridable) memory store. Same-path writes overwrite (official semantics:
// last write wins, conflict-retry only applies to the remote-backed store).

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
        'Memory store name. Defaults to the project-scoped store derived from the current project directory. Same root as LocalMemoryRecall.',
      ),
    path: z
      .string()
      .regex(new RegExp(PATH_REGEX_STRING))
      .max(256)
      .describe(
        'Relative document path ending in .md, e.g. "notes/retry-logic.md". Segments: [A-Za-z0-9._-]; no absolute paths or "..".',
      ),
    content: z
      .string()
      .min(1)
      .describe('Markdown body of the document (max 1 MB).'),
    name: z
      .string()
      .max(128)
      .optional()
      .describe('Frontmatter name. Defaults to the path stem.'),
    description: z
      .string()
      .max(2048)
      .optional()
      .describe('Short frontmatter description of what this doc remembers.'),
    type: z
      .enum(['user', 'project', 'feedback', 'general'])
      .optional()
      .describe('Frontmatter doc type. Defaults to "general".'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    store: z.string().optional(),
    path: z.string().optional(),
    bytes: z.number().optional(),
    created: z.boolean().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const MemoryWriteTool = buildTool({
  name: MEMORY_WRITE_TOOL_NAME,
  searchHint: 'save a document to a memory store',
  userFacingName: () => 'Memory Write',
  maxResultSizeChars: MAX_MEMORY_DOC_BYTES,
  async description() {
    return 'Save a markdown document (with name/description/type frontmatter) to the project memory store. Same-path writes overwrite.'
  },
  async prompt() {
    return 'Write a markdown + frontmatter document into the memory store. Provide a relative .md path; store defaults to the project-scoped store. Existing documents at the same path are overwritten.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `write ${input.store ?? ''}:${input.path ?? ''}: ${input.content.slice(0, 80)}`
  },
  async call(input: Input) {
    try {
      if (!isValidMemoryStoreName(input.store ?? '')) {
        return {
          data: { error: `Invalid store name: '${input.store}'` },
        }
      }
      const store = input.store ?? getDefaultStoreName()
      if (Buffer.byteLength(input.content, 'utf8') > MAX_MEMORY_DOC_BYTES) {
        return {
          data: {
            store,
            path: input.path,
            error: `Content too large (max ${MAX_MEMORY_DOC_BYTES} bytes).`,
          },
        }
      }
      // Throws on traversal / symlink escape — caught below.
      const { target } = resolveMemoryEntryPath(store, input.path, {
        create: true,
      })
      const stem = input.path.slice(0, -3) // strip trailing ".md"
      const doc = serializeMemoryDoc(
        {
          name: (input.name ?? stem).trim() || stem,
          description: input.description?.trim(),
          type: input.type ?? 'general',
        },
        input.content.endsWith('\n') ? input.content : `${input.content}\n`,
      )
      const existed = existsSync(target)
      writeFileAtomic(target, doc)
      const out: Output = {
        store,
        path: input.path,
        bytes: Buffer.byteLength(doc, 'utf8'),
        created: !existed,
      }
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
    return renderToolUseMessage('write', input, options)
  },
  renderToolResultMessage(output, progressMessages, options) {
    return renderMemoryWriteResult(
      output as unknown as Parameters<typeof renderMemoryWriteResult>[0],
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
