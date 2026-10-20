import { z } from 'zod/v4'
import { existsSync } from 'node:fs'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { MAX_MEMORY_DOC_BYTES, MEMORY_WRITE_TOOL_NAME } from './constants.js'
import {
  checkStoreWritable,
  resolveStoreAccess,
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
        'Memory store name. Defaults to the project-scoped store derived from the current project directory. Must be a store available in this session (the project store or an existing store in the shared local-memory root); writes land in the project store only.',
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
      .describe('Markdown body of the document (max 102400 bytes).'),
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
  /**
   * checkPermissions 面（官方无 CCH 的 canUseTool 透写——官方 2.8.4 对
   * memory_write 是 refused/read-only；CCH 保留写入属超出官方的扩展，按
   * 任务约定必须过 canUseTool 权限门）：
   *   - store 不在本会话可用集 → deny（官方 unknown_store 文案）
   *   - store 非当前项目默认 store → deny（官方 read_only 文案）
   *   - 其余 → ask：真权限交互门（规则 allow 可越过，deny 规则可封）。
   */
  async checkPermissions(input: Input) {
    const resolved = resolveStoreAccess(input.store)
    if (resolved.error !== undefined) {
      return {
        behavior: 'deny' as const,
        message: resolved.error,
        decisionReason: { type: 'other' as const, reason: 'unknown_store' },
      }
    }
    const writeRefusal = checkStoreWritable(resolved.store)
    if (writeRefusal !== undefined) {
      return {
        behavior: 'deny' as const,
        message: writeRefusal,
        decisionReason: { type: 'other' as const, reason: 'read_only_store' },
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Allow saving to memory store "${resolved.store}" (${input.path})?`,
      decisionReason: {
        type: 'other' as const,
        reason: 'memory_write_requires_approval',
      },
    }
  },
  async call(input: Input) {
    try {
      // 官方 connected-store 面（reverse-284 _ALL.js:5230 Eit）：store 缺省落
      // 项目默认；显式 store 必须在本会话可用集内，否则 refused/unknown_store。
      const resolved = resolveStoreAccess(input.store)
      if (resolved.error !== undefined) {
        return { data: { error: resolved.error } }
      }
      const store = resolved.store
      // 官方 writable 面（n && !a.writable → refused/read_only）：白名单内
      // 的共享/project-* store 一律拒写，只有当前项目默认 store 可写。
      const writeRefusal = checkStoreWritable(store)
      if (writeRefusal !== undefined) {
        return { data: { error: writeRefusal } }
      }
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
