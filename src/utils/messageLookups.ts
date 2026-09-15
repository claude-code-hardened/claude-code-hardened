// biome-ignore-all assist/source/organizeImports: 从 messages.ts 原样迁出，保持导入分组不变
/**
 * 消息渲染索引（MessageLookups）的构建、增量维护与缓存策略。
 *
 * 从 messages.ts 迁出为独立模块：本模块只有类型导入，零运行时依赖，
 * 因此差分对拍/基准脚本（scripts/differential-hotpath.ts、
 * scripts/bench-hotpath.ts）可以不经 CLI 依赖链直接驱动真实实现。
 * messages.ts 对外 re-export 保持既有公共 API 与测试导入路径不变。
 */
import type {
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedMessage,
  ProgressMessage,
  UserMessage,
} from '../types/message.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type {
  HookAttachment,
  HookPermissionDecisionAttachment,
} from './attachments.js'

// Hook attachments that have a hookName field (excludes HookPermissionDecisionAttachment)
export type HookAttachmentWithName = Exclude<
  HookAttachment,
  HookPermissionDecisionAttachment
>

export function isHookAttachmentMessage(
  message: Message,
): message is AttachmentMessage<HookAttachment> {
  return (
    message.type === 'attachment' &&
    (message.attachment?.type === 'hook_blocking_error' ||
      message.attachment?.type === 'hook_cancelled' ||
      message.attachment?.type === 'hook_error_during_execution' ||
      message.attachment?.type === 'hook_non_blocking_error' ||
      message.attachment?.type === 'hook_success' ||
      message.attachment?.type === 'hook_system_message' ||
      message.attachment?.type === 'hook_additional_context' ||
      message.attachment?.type === 'hook_stopped_continuation')
  )
}

export type MessageLookups = {
  siblingToolUseIDs: Map<string, Set<string>>
  progressMessagesByToolUseID: Map<string, ProgressMessage[]>
  inProgressHookCounts: Map<string, Map<HookEvent, number>>
  resolvedHookCounts: Map<string, Map<HookEvent, number>>
  /** Maps tool_use_id to the user message containing its tool_result */
  toolResultByToolUseID: Map<string, NormalizedMessage>
  /** Maps tool_use_id to the ToolUseBlockParam */
  toolUseByToolUseID: Map<string, ToolUseBlockParam>
  /** Total count of normalized messages (for truncation indicator text) */
  normalizedMessageCount: number
  /** Set of tool use IDs that have a corresponding tool_result */
  resolvedToolUseIDs: Set<string>
  /** Set of tool use IDs that have an errored tool_result */
  erroredToolUseIDs: Set<string>
}

/**
 * 每第 N 次消息状态变更（含增量更新与就地内容变更）后，下一次变更强制
 * 从权威数据源全量重编索引（N = 4）。增量更新只在"纯追加"时应用，但
 * 消息数组还存在难以从结构键察觉的漂移源（如 tool_result 的 is_error
 * 就地翻转）；定期全量重编兜底清零累积漂移。计数器本体在
 * MessageLookupsCache 中维护。
 */
export const LOOKUPS_FULL_REBUILD_INTERVAL = 4

/**
 * buildMessageLookups 按 hookName 去重后再计数（单个 hook 可能产生
 * hook_success + hook_additional_context 两条 attachment）。增量更新要
 * 与全量重编完全等价，必须跨调用保留这份"已见 hookName"状态；挂在
 * WeakMap 上避免改变 MessageLookups 的可见结构（序列化等价性）。
 */
const resolvedHookNamesByLookups = new WeakMap<
  MessageLookups,
  Map<string, Map<HookEvent, Set<string>>>
>()

/**
 * Build pre-computed lookups for efficient O(1) access to message relationships.
 * Call once per render, then use the lookups for all messages.
 *
 * This avoids O(n²) behavior from calling getProgressMessagesForMessage,
 * getSiblingToolUseIDs, and hasUnresolvedHooks for each message.
 */
export function buildMessageLookups(
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): MessageLookups {
  // First pass: group assistant messages by ID and collect all tool use IDs per message
  const toolUseIDsByMessageID = new Map<string, Set<string>>()
  const toolUseIDToMessageID = new Map<string, string>()
  const toolUseByToolUseID = new Map<string, ToolUseBlockParam>()
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const aMsg = msg as AssistantMessage
      const id = aMsg.message.id!
      let toolUseIDs = toolUseIDsByMessageID.get(id)
      if (!toolUseIDs) {
        toolUseIDs = new Set()
        toolUseIDsByMessageID.set(id, toolUseIDs)
      }
      if (Array.isArray(aMsg.message.content)) {
        for (const content of aMsg.message.content) {
          if (typeof content !== 'string' && content.type === 'tool_use') {
            const toolUseContent = content as ToolUseBlock
            toolUseIDs.add(toolUseContent.id)
            toolUseIDToMessageID.set(toolUseContent.id, id)
            toolUseByToolUseID.set(
              toolUseContent.id,
              content as ToolUseBlockParam,
            )
          }
        }
      }
    }
  }

  // Build sibling lookup - each tool use ID maps to all sibling tool use IDs
  const siblingToolUseIDs = new Map<string, Set<string>>()
  for (const [toolUseID, messageID] of toolUseIDToMessageID) {
    siblingToolUseIDs.set(toolUseID, toolUseIDsByMessageID.get(messageID)!)
  }

  // Single pass over normalizedMessages to build progress, hook, and tool result lookups
  const progressMessagesByToolUseID = new Map<string, ProgressMessage[]>()
  const inProgressHookCounts = new Map<string, Map<HookEvent, number>>()
  // Track unique hook names per (toolUseID, hookEvent) to match getResolvedHookCount behavior.
  // A single hook can produce multiple attachment messages (e.g., hook_success + hook_additional_context),
  // so we deduplicate by hookName.
  const resolvedHookNames = new Map<string, Map<HookEvent, Set<string>>>()
  const toolResultByToolUseID = new Map<string, NormalizedMessage>()
  // Track resolved/errored tool use IDs (replaces separate useMemos in Messages.tsx)
  const resolvedToolUseIDs = new Set<string>()
  const erroredToolUseIDs = new Set<string>()

  for (const msg of normalizedMessages) {
    if (msg.type === 'progress') {
      // Build progress messages lookup
      const toolUseID = msg.parentToolUseID as string
      const existing = progressMessagesByToolUseID.get(toolUseID)
      if (existing) {
        existing.push(msg as ProgressMessage)
      } else {
        progressMessagesByToolUseID.set(toolUseID, [msg as ProgressMessage])
      }

      // Count in-progress hooks
      const progressData = msg.data as
        | { type: string; hookEvent: HookEvent }
        | null
        | undefined
      if (progressData && progressData.type === 'hook_progress') {
        const hookEvent = progressData.hookEvent
        let byHookEvent = inProgressHookCounts.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          inProgressHookCounts.set(toolUseID, byHookEvent)
        }
        byHookEvent.set(hookEvent, (byHookEvent.get(hookEvent) ?? 0) + 1)
      }
    }

    // Build tool result lookup and resolved/errored sets
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content !== 'string' && content.type === 'tool_result') {
          const tr = content as ToolResultBlockParam
          toolResultByToolUseID.set(tr.tool_use_id, msg)
          resolvedToolUseIDs.add(tr.tool_use_id)
          if (tr.is_error) {
            erroredToolUseIDs.add(tr.tool_use_id)
          }
        }
      }
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content === 'string') continue
        // Track all server-side *_tool_result blocks (advisor, web_search,
        // code_execution, mcp, etc.) — any block with tool_use_id is a result.
        if (
          'tool_use_id' in content &&
          typeof (content as { tool_use_id: string }).tool_use_id === 'string'
        ) {
          resolvedToolUseIDs.add(
            (content as { tool_use_id: string }).tool_use_id,
          )
        }
        if ((content.type as string) === 'advisor_tool_result') {
          const result = content as {
            tool_use_id: string
            content: { type: string }
          }
          if (result.content.type === 'advisor_tool_result_error') {
            erroredToolUseIDs.add(result.tool_use_id)
          }
        }
      }
    }

    // Count resolved hooks (deduplicate by hookName)
    if (isHookAttachmentMessage(msg)) {
      const toolUseID = msg.attachment.toolUseID
      const hookEvent = msg.attachment.hookEvent
      const hookName = (msg.attachment as HookAttachmentWithName).hookName
      if (hookName !== undefined) {
        let byHookEvent = resolvedHookNames.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          resolvedHookNames.set(toolUseID, byHookEvent)
        }
        let names = byHookEvent.get(hookEvent)
        if (!names) {
          names = new Set()
          byHookEvent.set(hookEvent, names)
        }
        names.add(hookName)
      }
    }
  }

  // Convert resolved hook name sets to counts
  const resolvedHookCounts = new Map<string, Map<HookEvent, number>>()
  for (const [toolUseID, byHookEvent] of resolvedHookNames) {
    const countMap = new Map<HookEvent, number>()
    for (const [hookEvent, names] of byHookEvent) {
      countMap.set(hookEvent, names.size)
    }
    resolvedHookCounts.set(toolUseID, countMap)
  }

  // Mark orphaned server_tool_use / mcp_tool_use blocks (no matching
  // result) as errored so the UI shows them as failed instead of
  // perpetually spinning.
  const lastMsg = messages.at(-1)
  const lastAssistantMsgId =
    lastMsg?.type === 'assistant' ? lastMsg.message?.id : undefined
  for (const msg of normalizedMessages) {
    if (msg.type !== 'assistant') continue
    const aMsg = msg as AssistantMessage
    // Skip blocks from the last original message if it's an assistant,
    // since it may still be in progress.
    if (aMsg.message.id === lastAssistantMsgId) continue
    if (!Array.isArray(aMsg.message.content)) continue
    for (const content of aMsg.message.content) {
      if (
        typeof content !== 'string' &&
        ((content.type as string) === 'server_tool_use' ||
          (content.type as string) === 'mcp_tool_use') &&
        !resolvedToolUseIDs.has((content as { id: string }).id)
      ) {
        const id = (content as { id: string }).id
        resolvedToolUseIDs.add(id)
        erroredToolUseIDs.add(id)
      }
    }
  }

  const lookups: MessageLookups = {
    siblingToolUseIDs,
    progressMessagesByToolUseID,
    inProgressHookCounts,
    resolvedHookCounts,
    toolResultByToolUseID,
    toolUseByToolUseID,
    normalizedMessageCount: normalizedMessages.length,
    resolvedToolUseIDs,
    erroredToolUseIDs,
  }
  // 保留 hookName 去重状态，供后续 updateMessageLookupsIncremental 与
  // 全量重编保持计数语义一致。
  resolvedHookNamesByLookups.set(lookups, resolvedHookNames)
  return lookups
}

/**
 * Incrementally update lookups by processing only newly appended messages.
 * Returns the same lookups object (mutated in place) if update succeeds,
 * or null if a full rebuild is needed (e.g., messages were removed).
 */
export function updateMessageLookupsIncremental(
  existing: MessageLookups,
  previousNormalizedCount: number,
  previousMessageCount: number,
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): MessageLookups | null {
  // Safety check: only handle append-only case
  if (
    normalizedMessages.length < previousNormalizedCount ||
    messages.length < previousMessageCount
  ) {
    return null
  }

  // No new messages — nothing to do, UNLESS the trailing message is a
  // progress tick. REPL.tsx replaces ephemeral progress (Bash/PowerShell/MCP)
  // in-place to bound the messages array — same length, but the trailing
  // progress is a fresh tick. Returning `existing` here would leave
  // progressMessagesByToolUseID stuck on the first tick and elapsed-time
  // displays (ShellProgressMessage) would freeze. Force a full rebuild so
  // the fresh tick propagates.
  if (
    normalizedMessages.length === previousNormalizedCount &&
    messages.length === previousMessageCount
  ) {
    const lastNormalized = normalizedMessages[normalizedMessages.length - 1]
    if (lastNormalized && lastNormalized.type === 'progress') {
      return null
    }
    return existing
  }

  // resolvedHookCounts 必须与全量重编一样按 hookName 去重。去重状态缺失
  // （lookups 对象不是本模块构建的）时无法保证等价 — 强制全量重编。
  const hookNamesState = resolvedHookNamesByLookups.get(existing)
  if (!hookNamesState) {
    return null
  }

  // Process new messages entries (pass 1: assistant tool_use blocks)
  const newMessageStart = previousMessageCount
  for (let i = newMessageStart; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant') {
      const aMsg = msg as AssistantMessage
      const _id = aMsg.message.id!
      if (Array.isArray(aMsg.message.content)) {
        const newToolUseIDs: string[] = []
        for (const content of aMsg.message.content) {
          if (typeof content !== 'string' && content.type === 'tool_use') {
            const toolUseContent = content as ToolUseBlock
            newToolUseIDs.push(toolUseContent.id)
            existing.toolUseByToolUseID.set(
              toolUseContent.id,
              content as ToolUseBlockParam,
            )
          }
        }
        // Update sibling lookup: all tool_use IDs in this message share siblings
        const allSiblings = new Set(newToolUseIDs)
        for (const toolUseID of newToolUseIDs) {
          existing.siblingToolUseIDs.set(toolUseID, allSiblings)
        }
      }
    }
  }

  // Process new normalizedMessages entries (pass 2: progress, hooks, tool results)
  const newNormalizedStart = previousNormalizedCount
  for (let i = newNormalizedStart; i < normalizedMessages.length; i++) {
    const msg = normalizedMessages[i]!

    if (msg.type === 'progress') {
      const toolUseID = msg.parentToolUseID as string
      const existing2 = existing.progressMessagesByToolUseID.get(toolUseID)
      if (existing2) {
        existing2.push(msg as ProgressMessage)
      } else {
        existing.progressMessagesByToolUseID.set(toolUseID, [
          msg as ProgressMessage,
        ])
      }

      const progressData = msg.data as
        | { type: string; hookEvent: HookEvent }
        | null
        | undefined
      if (progressData && progressData.type === 'hook_progress') {
        const hookEvent = progressData.hookEvent
        let byHookEvent = existing.inProgressHookCounts.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          existing.inProgressHookCounts.set(toolUseID, byHookEvent)
        }
        byHookEvent.set(hookEvent, (byHookEvent.get(hookEvent) ?? 0) + 1)
      }
    }

    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content !== 'string' && content.type === 'tool_result') {
          const tr = content as ToolResultBlockParam
          existing.toolResultByToolUseID.set(tr.tool_use_id, msg)
          existing.resolvedToolUseIDs.add(tr.tool_use_id)
          if (tr.is_error) {
            existing.erroredToolUseIDs.add(tr.tool_use_id)
          }
        }
      }
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const content of msg.message?.content ?? []) {
        if (typeof content === 'string') continue
        if (
          'tool_use_id' in content &&
          typeof (content as { tool_use_id: string }).tool_use_id === 'string'
        ) {
          existing.resolvedToolUseIDs.add(
            (content as { tool_use_id: string }).tool_use_id,
          )
        }
        if ((content.type as string) === 'advisor_tool_result') {
          const result = content as {
            tool_use_id: string
            content: { type: string }
          }
          if (result.content.type === 'advisor_tool_result_error') {
            existing.erroredToolUseIDs.add(result.tool_use_id)
          }
        }
      }
    }

    // 与全量重编一致：按 hookName 去重后计数（names.size），而非逐条
    // attachment 累加 — 同一 hook 可产出多条 attachment 消息。
    if (isHookAttachmentMessage(msg)) {
      const toolUseID = msg.attachment.toolUseID
      const hookEvent = msg.attachment.hookEvent
      const hookName = (msg.attachment as HookAttachmentWithName).hookName
      if (hookName !== undefined) {
        let byHookEvent = hookNamesState.get(toolUseID)
        if (!byHookEvent) {
          byHookEvent = new Map()
          hookNamesState.set(toolUseID, byHookEvent)
        }
        let names = byHookEvent.get(hookEvent)
        if (!names) {
          names = new Set()
          byHookEvent.set(hookEvent, names)
        }
        names.add(hookName)
        let countMap = existing.resolvedHookCounts.get(toolUseID)
        if (!countMap) {
          countMap = new Map()
          existing.resolvedHookCounts.set(toolUseID, countMap)
        }
        countMap.set(hookEvent, names.size)
      }
    }
  }

  existing.normalizedMessageCount = normalizedMessages.length

  // Mark orphaned server_tool_use / mcp_tool_use blocks as errored.
  // Only scan the new normalizedMessages since the previous count —
  // existing entries were already checked by a prior full build.
  const lastMsg = messages.at(-1)
  const lastAssistantMsgId =
    lastMsg?.type === 'assistant' ? lastMsg.message?.id : undefined
  for (let i = newNormalizedStart; i < normalizedMessages.length; i++) {
    const msg = normalizedMessages[i]!
    if (msg.type !== 'assistant') continue
    const aMsg = msg as AssistantMessage
    if (aMsg.message.id === lastAssistantMsgId) continue
    if (!Array.isArray(aMsg.message.content)) continue
    for (const content of aMsg.message.content) {
      if (
        typeof content !== 'string' &&
        ((content.type as string) === 'server_tool_use' ||
          (content.type as string) === 'mcp_tool_use') &&
        !existing.resolvedToolUseIDs.has((content as { id: string }).id)
      ) {
        const id = (content as { id: string }).id
        existing.resolvedToolUseIDs.add(id)
        existing.erroredToolUseIDs.add(id)
      }
    }
  }

  return existing
}

/**
 * Compute a lightweight structural fingerprint for buildMessageLookups caching.
 * Only captures information that affects lookup results (types, IDs, counts),
 * not content. Returns an empty string when the arrays are structurally empty.
 *
 * O(n) but allocates only a string — much cheaper than the 8 Maps/Sets that
 * buildMessageLookups creates on every call.
 */
export function computeMessageStructureKey(
  normalizedMessages: NormalizedMessage[],
  messages: Message[],
): string {
  const parts: string[] = [
    String(normalizedMessages.length),
    '|',
    String(messages.length),
  ]
  for (const msg of messages) {
    parts.push(msg.type[0])
    if (msg.type === 'assistant') {
      const aMsg = msg as AssistantMessage
      const content = aMsg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'string' && block.type === 'tool_use') {
            parts.push('t', (block as ToolUseBlock).id)
          }
        }
      }
    } else if (msg.type === 'user') {
      const content = (msg as UserMessage).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'string' && block.type === 'tool_result') {
            parts.push('r', (block as ToolResultBlockParam).tool_use_id)
          }
        }
      }
    }
  }
  for (const msg of normalizedMessages) {
    if (msg.type === 'progress') {
      const pMsg = msg as ProgressMessage
      // Include uuid so ephemeral progress tick replacements
      // (Bash/PowerShell/MCP) invalidate the lookups cache. Without this,
      // REPL.tsx's in-place tick replacement (same parentToolUseID, same
      // length) yields an identical key, lookups cache the first tick
      // forever, and ShellProgressMessage's elapsed time freezes.
      parts.push('p', pMsg.parentToolUseID as string, pMsg.uuid)
    }
  }
  return parts.join(',')
}

/** Empty lookups for static rendering contexts that don't need real lookups. */
export const EMPTY_LOOKUPS: MessageLookups = {
  siblingToolUseIDs: new Map(),
  progressMessagesByToolUseID: new Map(),
  inProgressHookCounts: new Map(),
  resolvedHookCounts: new Map(),
  toolResultByToolUseID: new Map(),
  toolUseByToolUseID: new Map(),
  normalizedMessageCount: 0,
  resolvedToolUseIDs: new Set(),
  erroredToolUseIDs: new Set(),
}

type LookupsCacheState = {
  key: string
  lookups: MessageLookups
  normalizedCount: number
  messageCount: number
  lastAssistantMsgId: string | undefined
  /** 最近一次 get() 的输入数组引用，用于检测就地内容变更。 */
  normalizedRef: NormalizedMessage[]
  messagesRef: Message[]
  /** 距上次全量重编累计的变更次数（含增量更新与内容级复用）。 */
  changeCount: number
}

/**
 * buildMessageLookups 的消费方缓存：结构键命中 → 复用；纯追加 →
 * updateMessageLookupsIncremental；其余（含每第
 * LOOKUPS_FULL_REBUILD_INTERVAL 次变更的兜底）→ 全量重编。
 *
 * 同一实例贯穿整个回合复用；回合结束 / unmount 时调用 reset()，
 * 下一次 get() 从权威数据源全量重编。
 */
export class MessageLookupsCache {
  private state: LookupsCacheState | null = null

  /** 回合结束 / unmount 时调用：丢弃增量状态，下次 get() 全量重编。 */
  reset(): void {
    this.state = null
  }

  get(
    normalizedMessages: NormalizedMessage[],
    messages: Message[],
    lastAssistantMsgId: string | undefined,
  ): MessageLookups {
    const cache = this.state
    // 变更检测：任一输入数组引用变化即为一次变更 — 覆盖纯追加（走
    // 增量分支）与结构键相同的就地内容变更（走复用分支），两者都可能
    // 让增量索引累积漂移，统一计入兜底计数器。
    const changed =
      cache !== null &&
      (cache.normalizedRef !== normalizedMessages ||
        cache.messagesRef !== messages)
    // 每第 N 次变更强制全量重编（N=LOOKUPS_FULL_REBUILD_INTERVAL）：
    // changeCount 已累计 N-1 次时，本次变更不再复用/增量，直接重编清零。
    const forceFullRebuild =
      changed && cache!.changeCount >= LOOKUPS_FULL_REBUILD_INTERVAL - 1
    const lookupsKey = computeMessageStructureKey(normalizedMessages, messages)

    if (cache && !forceFullRebuild && cache.key === lookupsKey) {
      if (changed) {
        cache.normalizedRef = normalizedMessages
        cache.messagesRef = messages
        cache.changeCount += 1
      }
      return cache.lookups
    }
    if (
      cache &&
      !forceFullRebuild &&
      normalizedMessages.length >= cache.normalizedCount &&
      messages.length >= cache.messageCount &&
      // 增量更新只服务"至少一个数组严格增长"的纯追加场景。等长的结构
      // 变更（消息编辑/就地替换）走到这里说明内容变了 — 增量更新器的
      // 等长快速路径只会原样返回旧索引，必须全量重编（正确性铁律）。
      (normalizedMessages.length > cache.normalizedCount ||
        messages.length > cache.messageCount) &&
      // If lastAssistantMsgId changed, previous "in-progress" assistant may
      // now be orphaned — force a full rebuild to pick up the new status.
      cache.lastAssistantMsgId === lastAssistantMsgId
    ) {
      // Try incremental update when only new messages were appended
      const updated = updateMessageLookupsIncremental(
        cache.lookups,
        cache.normalizedCount,
        cache.messageCount,
        normalizedMessages,
        messages,
      )
      if (updated) {
        this.state = {
          key: lookupsKey,
          lookups: updated,
          normalizedCount: normalizedMessages.length,
          messageCount: messages.length,
          lastAssistantMsgId,
          normalizedRef: normalizedMessages,
          messagesRef: messages,
          changeCount: cache.changeCount + 1,
        }
        return updated
      }
    }
    const lookups = buildMessageLookups(normalizedMessages, messages)
    this.state = {
      key: lookupsKey,
      lookups,
      normalizedCount: normalizedMessages.length,
      messageCount: messages.length,
      lastAssistantMsgId,
      normalizedRef: normalizedMessages,
      messagesRef: messages,
      changeCount: 0,
    }
    return lookups
  }
}
