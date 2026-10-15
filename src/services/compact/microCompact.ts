import { feature } from 'bun:bundle'
import type {
  DocumentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/WebSearchTool/prompt.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { notifyCacheDeletion } from '../api/promptCacheBreakDetection.js'
import {
  countTokensPrecise,
  roughTokenCountEstimation,
} from '../tokenEstimation.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from './compactWarningState.js'
import {
  getTimeBasedMCConfig,
  type TimeBasedMCConfig,
} from './timeBasedMCConfig.js'

// Inline from utils/toolResultStorage.ts — importing that file pulls in
// sessionStorage → utils/messages → services/api/errors, completing a
// circular-deps loop back through this file via promptCacheBreakDetection.
// Drift is caught by a test asserting equality with the source-of-truth.
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

const IMAGE_MAX_TOKEN_SIZE = 2000

// Only compact these tools
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

// --- Cached microcompact state (ant-only, gated by feature('CACHED_MICROCOMPACT')) ---

// Lazy-initialized cached MC module and state to avoid importing in external builds.
// The imports and state live inside feature() checks for dead code elimination.
let cachedMCModule: typeof import('./cachedMicrocompact.js') | null = null
let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null = null
let pendingCacheEdits:
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null = null

async function getCachedMCModule(): Promise<
  typeof import('./cachedMicrocompact.js')
> {
  if (!cachedMCModule) {
    cachedMCModule = await import('./cachedMicrocompact.js')
  }
  return cachedMCModule
}

function ensureCachedMCState(): import('./cachedMicrocompact.js').CachedMCState {
  if (!cachedMCState && cachedMCModule) {
    cachedMCState = cachedMCModule.createCachedMCState()
  }
  if (!cachedMCState) {
    throw new Error(
      'cachedMCState not initialized — getCachedMCModule() must be called first',
    )
  }
  return cachedMCState
}

/**
 * Get new pending cache edits to be included in the next API request.
 * Returns null if there are no new pending edits.
 * Clears the pending state (caller must pin them after insertion).
 */
export function consumePendingCacheEdits():
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}

/**
 * Get all previously-pinned cache edits that must be re-sent at their
 * original positions for cache hits.
 */
export function getPinnedCacheEdits(): import('./cachedMicrocompact.js').PinnedCacheEdits[] {
  if (!cachedMCState) {
    return []
  }
  return cachedMCState.pinnedEdits
}

/**
 * Pin a new cache_edits block to a specific user message position.
 * Called after inserting new edits so they are re-sent in subsequent calls.
 */
export function pinCacheEdits(
  userMessageIndex: number,
  block: import('./cachedMicrocompact.js').CacheEditsBlock,
): void {
  if (cachedMCState) {
    cachedMCState.pinnedEdits.push({ userMessageIndex, block })
  }
}

/**
 * Marks all registered tools as sent to the API.
 * Called after a successful API response.
 */
export function markToolsSentToAPIState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.markToolsSentToAPI(cachedMCState)
  }
}

export function resetMicrocompactState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.resetCachedMCState(cachedMCState)
  }
  pendingCacheEdits = null
}

// Helper to calculate tool result tokens
function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (!block.content) {
    return 0
  }

  if (typeof block.content === 'string') {
    return countTokensPrecise(block.content)
  }

  // Array of TextBlockParam | ImageBlockParam | DocumentBlockParam
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + countTokensPrecise(item.text)
    } else if (item.type === 'image' || item.type === 'document') {
      // Images/documents are approximately 2000 tokens regardless of format
      return sum + IMAGE_MAX_TOKEN_SIZE
    }
    return sum
  }, 0)
}

/**
 * Estimate token count for messages by extracting text content
 * Used for rough token estimation when we don't have accurate API counts
 * Pads estimate by 4/3 to be conservative since we're approximating
 */
export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    if (!Array.isArray(message.message!.content)) {
      continue
    }

    for (const block of message.message!.content) {
      if (block.type === 'text') {
        totalTokens += countTokensPrecise(block.text)
      } else if (block.type === 'tool_result') {
        totalTokens += calculateToolResultTokens(block)
      } else if (block.type === 'image' || block.type === 'document') {
        totalTokens += IMAGE_MAX_TOKEN_SIZE
      } else if (block.type === 'thinking') {
        // Match roughTokenCountEstimationForBlock: count only the thinking
        // text, not the JSON wrapper or signature (signature is metadata,
        // not model-tokenized content).
        totalTokens += countTokensPrecise(block.thinking)
      } else if (block.type === 'redacted_thinking') {
        totalTokens += countTokensPrecise(block.data)
      } else if (block.type === 'tool_use') {
        // Match roughTokenCountEstimationForBlock: count name + input,
        // not the JSON wrapper or id field.
        totalTokens += countTokensPrecise(
          block.name + jsonStringify(block.input ?? {}),
        )
      } else {
        // server_tool_use, web_search_tool_result, etc.
        totalTokens += countTokensPrecise(jsonStringify(block))
      }
    }
  }

  // Pad estimate by 4/3 to be conservative since we're approximating
  return Math.ceil(totalTokens * (4 / 3))
}

export type PendingCacheEdits = {
  trigger: 'auto'
  deletedToolIds: string[]
  // Baseline cumulative cache_deleted_input_tokens from the previous API response,
  // used to compute the per-operation delta (the API value is sticky/cumulative)
  baselineCacheDeletedTokens: number
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
  // Tool use IDs whose content was replaced with the cleared message.
  // Callers should remove these from contentReplacementState.replacements
  // to release the original strings from memory.
  clearedToolUseIds?: string[]
  // MEMORY_PROJECTION only: tool_use_id → the exact replacement string that
  // was applied in the request projection. query.ts uses this to sync-replace
  // the shared mutable message list (REPL state) so the originals can be GC'd.
  clearedReplacements?: Map<string, string>
  // MEMORY_PROJECTION only: file paths (Read tool inputs) whose readFileState
  // entries must be dropped for cleared tool calls (official UI contract).
  readFileStatePaths?: string[]
}

/**
 * Walk messages and collect tool_use IDs whose tool name is in
 * COMPACTABLE_TOOLS, in encounter order. Shared by both microcompact paths.
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message!.content)
    ) {
      for (const block of message.message!.content) {
        if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

// Prefix-match because promptCategory.ts sets the querySource to
// 'repl_main_thread:outputStyle:<style>' when a non-default output style
// is active. The bare 'repl_main_thread' is only used for the default style.
// query.ts:350/1451 use the same startsWith pattern; the pre-existing
// cached-MC `=== 'repl_main_thread'` check was a latent bug — users with a
// non-default output style were silently excluded from cached MC.
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // Clear suppression flag at start of new microcompact attempt
  clearCompactWarningSuppression()

  // MEMORY_PROJECTION: official 2.1.284 time-based microcompact
  // (tool_result_clear) ported as a local memory projection. Runs at every
  // request build when enabled; declines silently below the official gates
  // so the legacy time-based / cached-MC paths below remain the fallback
  // (flag off → this block is eliminated and behavior is byte-for-byte the
  // pre-existing one).
  if (feature('MEMORY_PROJECTION')) {
    const projection = await clearToolResultProjection(messages, querySource)
    if (projection) {
      return {
        messages: projection.messages,
        clearedToolUseIds: projection.clearedToolUseIds,
        clearedReplacements: projection.clearedReplacements,
        readFileStatePaths: projection.readFileStatePaths,
      }
    }
  }

  // Time-based trigger runs first and short-circuits. If the gap since the
  // last assistant message exceeds the threshold, the server cache has expired
  // and the full prefix will be rewritten regardless — so content-clear old
  // tool results now, before the request, to shrink what gets rewritten.
  // Cached MC (cache-editing) is skipped when this fires: editing assumes a
  // warm cache, and we just established it's cold.
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // Only run cached MC for the main thread to prevent forked agents
  // (session_memory, prompt_suggestion, etc.) from registering their
  // tool_results in the global cachedMCState, which would cause the main
  // thread to try deleting tools that don't exist in its own conversation.
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // Legacy microcompact path removed — tengu_cache_plum_violet is always true.
  // For contexts where cached microcompact is not available (external builds,
  // non-ant users, unsupported models, sub-agents), no compaction happens here;
  // autocompact handles context pressure instead.
  return { messages }
}

/**
 * Cached microcompact path - uses cache editing API to remove tool results
 * without invalidating the cached prefix.
 *
 * Key differences from regular microcompact:
 * - Does NOT modify local message content (cache_reference and cache_edits are added at API layer)
 * - Uses count-based trigger/keep thresholds from GrowthBook config
 * - Takes precedence over regular microcompact (no disk persistence)
 * - Tracks tool results and queues cache edits for the API layer
 */
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()
  const config = mod.getCachedMCConfig()

  const compactableToolIds = new Set(collectCompactableToolIds(messages))
  // Second pass: register tool results grouped by user message
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message!.content)) {
      const groupIds: string[] = []
      for (const block of message.message!.content) {
        if (
          block.type === 'tool_result' &&
          compactableToolIds.has(block.tool_use_id) &&
          !state.registeredTools.has(block.tool_use_id)
        ) {
          mod.registerToolResult(state, block.tool_use_id)
          groupIds.push(block.tool_use_id)
        }
      }
      mod.registerToolMessage(state, groupIds)
    }
  }

  const toolsToDelete = mod.getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    // Create and queue the cache_edits block for the API layer
    const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits
    }

    logForDebugging(
      `Cached MC deleting ${toolsToDelete.length} tool(s): ${toolsToDelete.join(', ')}`,
    )

    // Log the event
    logEvent('tengu_cached_microcompact', {
      toolsDeleted: toolsToDelete.length,
      deletedToolIds: toolsToDelete.join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      activeToolCount: state.toolOrder.length - state.deletedRefs.size,
      triggerType:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      threshold: config.triggerThreshold,
      keepRecent: config.keepRecent,
    })

    // Suppress warning after successful compaction
    suppressCompactWarning()

    // Notify cache break detection that cache reads will legitimately drop
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      // Pass the actual querySource — isMainThreadSource now prefix-matches
      // so output-style variants enter here, and getTrackingKey keys on the
      // full source string, not the 'repl_main_thread' prefix.
      notifyCacheDeletion(querySource ?? 'repl_main_thread')
    }

    // Return messages unchanged - cache_reference and cache_edits are added at API layer
    // Boundary message is deferred until after API response so we can use
    // actual cache_deleted_input_tokens from the API instead of client-side estimates
    // Capture the baseline cumulative cache_deleted_input_tokens from the last
    // assistant message so we can compute a per-operation delta after the API call
    const lastAsst = messages.findLast(m => m.type === 'assistant')
    const baseline =
      lastAsst?.type === 'assistant'
        ? ((
            lastAsst.message!.usage as unknown as Record<
              string,
              number | undefined
            >
          )?.cache_deleted_input_tokens ?? 0)
        : 0

    return {
      messages,
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }

  // No compaction needed, return messages unchanged
  return { messages }
}

/**
 * Time-based microcompact: when the gap since the last main-loop assistant
 * message exceeds the configured threshold, content-clear all but the most
 * recent N compactable tool results.
 *
 * Returns null when the trigger doesn't fire (disabled, wrong source, gap
 * under threshold, nothing to clear) — caller falls through to other paths.
 *
 * Unlike cached MC, this mutates message content directly. The cache is cold,
 * so there's no cached prefix to preserve via cache_edits.
 */
/**
 * Check whether the time-based trigger should fire for this request.
 *
 * Returns the measured gap (minutes since last assistant message) when the
 * trigger fires, or null when it doesn't (disabled, wrong source, under
 * threshold, no prior assistant, unparseable timestamp).
 *
 * Extracted so other pre-request paths (e.g. snip force-apply) can consult
 * the same predicate without coupling to the tool-result clearing action.
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // Require an explicit main-thread querySource. isMainThreadSource treats
  // undefined as main-thread (for cached-MC backward-compat), but several
  // callers (/context, /compact, analyzeContext) invoke microcompactMessages
  // without a source for analysis-only purposes — they should not trigger.
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() -
      new Date(lastAssistant.timestamp as string | number).getTime()) /
    60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}

function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // Floor at 1: slice(-0) returns the full array (paradoxically keeps
  // everything), and clearing ALL results leaves the model with zero working
  // context. Neither degenerate is sensible — always keep at least the last.
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
      return message
    }
    let touched = false
    const newContent = message.message!.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  if (tokensSaved === 0) {
    return null
  }

  logEvent('tengu_time_based_microcompact', {
    gapMinutes: Math.round(gapMinutes),
    gapThresholdMinutes: config.gapThresholdMinutes,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    keepRecent: config.keepRecent,
    tokensSaved,
  })

  logForDebugging(
    `[TIME-BASED MC] gap ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, cleared ${clearSet.size} tool results (~${tokensSaved} tokens), kept last ${keepSet.size}`,
  )

  suppressCompactWarning()
  // Cached-MC state (module-level) holds tool IDs registered on prior turns.
  // We just content-cleared some of those tools AND invalidated the server
  // cache by changing prompt content. If cached-MC runs next turn with the
  // stale state, it would try to cache_edit tools whose server-side entries
  // no longer exist. Reset it.
  resetMicrocompactState()
  // We just changed the prompt content — the next response's cache read will
  // be low, but that's us, not a break. Tell the detector to expect a drop.
  // notifyCacheDeletion (not notifyCompaction) because it's already imported
  // here and achieves the same false-positive suppression — adding the second
  // symbol to the import was flagged by the circular-deps check.
  // Pass the actual querySource: getTrackingKey returns the full source string
  // (e.g. 'repl_main_thread:outputStyle:custom'), not just the prefix.
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
    notifyCacheDeletion(querySource)
  }

  return { messages: result, clearedToolUseIds: [...clearSet] }
}

// --- MEMORY_PROJECTION: time-based microcompact (tool_result_clear) port ---
//
// Port of official Claude Code 2.1.284's time-based microcompact as a local
// memory-release mechanism. Official semantics being reproduced:
//   1. Two admission pathways:
//      ① idle — now − last activity > 3900s (minIdleSeconds) AND ≥20 tool
//        calls in the conversation AND ≥3 clearable results;
//      ② context_hint — estimated tokensSaved ≥ 20000 at request build;
//        officially a `context_hint: context-hint-2026-04-09` beta is attached
//        and the clear executes after the server rejects with 422/424.
//   2. keepRecent: keep the last 5 whitelist tool_use ids (keepToolUses: 5).
//      Whitelist = COMPACTABLE_TOOLS above (Read/Bash/PowerShell/Grep/Glob/
//      WebSearch/WebFetch/Edit/Write).
//   3. Official 20k gate on the GROSS preview estimate (PLr Σ Hl, computed
//      pre-persist). Strictly `g < 20000` declines — g == 20000 EXACTLY
//      proceeds and executes the clear (_ALL.js:4544). There is NO
//      post-persist net gate in official; CCH's former net-basis second gate
//      violated the exact-20000 boundary and is removed (net is only debug
//      accounting now).
//   4. Placeholder: `[Old tool result content cleared]`, applied with the
//      official persist-first order: persist(content,id) runs whenever
//      content is TRUTHY — image/document arrays reach persist too (they
//      fail on non-text blocks there and fall back to the literal), while
//      ''/falsy content skips persist and lands on the literal directly.
//      EFt then picks visual → bare literal, else the persisted preview,
//      and wraps the replacement with the official Tt prefix
//      `<artifact-content-authored-by-others/>\n` when the ORIGINAL content
//      carries the artifact-authored marker (_ALL.js:4544, :372).
//   5. UI contract: no inline hint is yielded; the local message list is
//      sync-replaced and readFileState entries for cleared Read calls are
//      dropped (see syncProjectionToMutableMessages + query.ts release site).
//   6. Officially there is no "snip" — snipCompact/snipProjection are CCH
//      self-built and NOT part of this alignment.
//
// STRUCTURAL DEVIATION (the only one): CCH is multi-provider (OpenAI/Gemini/
// Grok first-party), and the server-side context_management `edits` API is
// unavailable there. The official flow is ①attach beta → ②server rejects
// 422/424 → ③clear, i.e. server-acknowledged clearing. In CCH there is no
// server round-trip to gate us, so the clear executes PURELY client-side in
// the request projection + mutableMessages memory: same wire-visible outcome
// (cleared tool_result content), same gates, no beta header attached (the
// `context_hint: context-hint-2026-04-09` beta is resurrection-unsafe for
// non-Anthropic endpoints and would hard-fail the request).
//
// Transcript-safety invariant: the clear NEVER touches the transcript write
// path. Tool_result content is only replaced in (a) the per-request projection
// arrays built by .map() and (b) the REPL-owned mutableMessages objects, whose
// transcript entries were already uuid-recorded at yield time —
// recordTranscript dedups by uuid, so mutated old messages are never
// re-serialized. Resume stays byte-compatible (the JSONL keeps originals).

/** Official keepToolUses: the last N whitelist tool_use ids are kept. */
const MEMORY_PROJECTION_KEEP_TOOL_USES = 5

/**
 * Official mun = 20000 (_ALL.js:4544): the GROSS preview estimate (Σ Hl over
 * candidate blocks, pre-persist) must satisfy `g >= 20000` — strictly less
 * declines, so g == 20000 exactly still executes the clear.
 */
const MEMORY_PROJECTION_MIN_TOKENS_SAVED = 20_000

/** Official minIdleSeconds = 3900s for the idle pathway. */
const MEMORY_PROJECTION_MIN_IDLE_MS = 3_900_000

/** Official idle pathway floor: ≥20 tool calls in the conversation. */
const MEMORY_PROJECTION_MIN_TOTAL_TOOL_USES = 20

/** Official idle pathway floor: ≥3 clearable results. */
const MEMORY_PROJECTION_MIN_CLEARABLE = 3

// Official _ALL.js:372 (FWt/Ym): the Tt wrap prefix and the raw marker.
// EFt wraps a replacement with Tt when the ORIGINAL tool_result content
// carries the marker and the replacement itself is not already Tt-prefixed
// (_ALL.js:4544: !E && !k.startsWith(Tt) && Nl(...) ? Tt + k : k).
const ARTIFACT_CONTENT_MARKER_PREFIX =
  '<artifact-content-authored-by-others/>\n'
const ARTIFACT_CONTENT_MARKER = '<artifact-content-authored-by-others/>'

export type MemoryProjectionCleared = {
  messages: Message[]
  clearedToolUseIds: string[]
  // tool_use_id → exact replacement string applied in the projection.
  clearedReplacements: Map<string, string>
  // Read-tool file paths evicted from readFileState for cleared calls.
  readFileStatePaths: string[]
  tokensSaved: number
}

// Lazy accessor for utils/toolResultStorage.ts. Static import is forbidden
// here (see the TIME_BASED_MC_CLEARED_MESSAGE comment above: it completes a
// circular-deps loop through promptCacheBreakDetection). Runtime require
// inside the flag-gated call path sidesteps module-init ordering entirely.
type ToolResultStorageModule = typeof import('../../utils/toolResultStorage.js')
let toolResultStorageModule: ToolResultStorageModule | null = null

function getToolResultStorage(): ToolResultStorageModule {
  if (!toolResultStorageModule) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    toolResultStorageModule =
      require('../../utils/toolResultStorage.js') as ToolResultStorageModule
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return toolResultStorageModule
}

export type ProjectionPersistFn = (
  content: NonNullable<ToolResultBlockParam['content']>,
  toolUseId: string,
) => Promise<
  | import('../../utils/toolResultStorage.js').PersistedToolResult
  | import('../../utils/toolResultStorage.js').PersistToolResultError
>

/** Count every tool_use block across the conversation (any tool name). */
function collectTotalToolUseCount(messages: Message[]): number {
  let count = 0
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message!.content)
    ) {
      for (const block of message.message!.content) {
        if (block.type === 'tool_use') count++
      }
    }
  }
  return count
}

function hasImageOrDocumentBlock(
  content: ToolResultBlockParam['content'],
): boolean {
  return (
    Array.isArray(content) &&
    content.some(b => b.type === 'image' || b.type === 'document')
  )
}

/**
 * Official :4544 zl — already-cleared detection over tool_result content.
 * String-only: strip an optional Tt wrap prefix, then the body must equal
 * the bare literal or start with the <persisted-output> preview tag. This is
 * what keeps Tt-wrapped cleared results (`<artifact-content.../>\n[Old tool
 * result content cleared]`) from being re-clear candidates.
 */
function isProjectionCleared(
  content: ToolResultBlockParam['content'],
): boolean {
  if (typeof content !== 'string') return false
  const body = content.startsWith(ARTIFACT_CONTENT_MARKER_PREFIX)
    ? content.slice(ARTIFACT_CONTENT_MARKER_PREFIX.length)
    : content
  return (
    body === TIME_BASED_MC_CLEARED_MESSAGE ||
    body.startsWith(getToolResultStorage().PERSISTED_OUTPUT_TAG)
  )
}

/**
 * Official :4544 Nl — does the ORIGINAL tool_result content carry the
 * artifact-authored marker (in a string, or in any text block of an array)?
 */
function contentIncludesArtifactMarker(
  content: ToolResultBlockParam['content'],
): boolean {
  if (typeof content === 'string') {
    return content.includes(ARTIFACT_CONTENT_MARKER)
  }
  if (!Array.isArray(content)) return false
  return content.some(
    b =>
      b.type === 'text' &&
      typeof b.text === 'string' &&
      b.text.includes(ARTIFACT_CONTENT_MARKER),
  )
}

/**
 * Official tr(:4440) via dec0043 Rn — token divisor derived from a document
 * title's extension: json/jsonl/jsonc → 2, anything else (or no dot) → 4.
 */
function projectionDocumentTokenDivisor(
  title: string | null | undefined,
): number {
  if (typeof title === 'string' && title.includes('.')) {
    const parts = title.split('.')
    const ext = (parts[parts.length - 1] ?? '').toLowerCase()
    return ext === 'json' || ext === 'jsonl' || ext === 'jsonc' ? 2 : 4
  }
  return 4
}

/**
 * Official dec0043 Rn — single document block estimate. Text-source documents
 * count `source.data` under the title-extension divisor; content-source
 * documents count per inner block (text → Cd, image → flat); every other
 * source (base64/url/file) is the flat image estimate.
 */
function projectionDocumentTokens(block: DocumentBlockParam): number {
  const source = block.source
  if (source.type === 'text') {
    return roughTokenCountEstimation(
      source.data,
      projectionDocumentTokenDivisor(block.title),
    )
  }
  if (source.type === 'content') {
    return typeof source.content === 'string'
      ? roughTokenCountEstimation(source.content)
      : source.content.reduce(
          (sum, inner) =>
            sum +
            (inner.type === 'text'
              ? roughTokenCountEstimation(inner.text)
              : IMAGE_MAX_TOKEN_SIZE),
          0,
        )
  }
  return IMAGE_MAX_TOKEN_SIZE
}

/**
 * Official :4544 Hl — tool_result token estimate for the MEMORY_PROJECTION
 * preview/gate: string → Cd(len/4); text blocks → Cd; image blocks → the
 * flat image estimate; document blocks → dec0043 Rn source semantics.
 */
function projectionToolResultTokens(
  content: ToolResultBlockParam['content'],
): number {
  if (!content) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block.type === 'text') {
      total += roughTokenCountEstimation(block.text)
    } else if (block.type === 'image') {
      total += IMAGE_MAX_TOKEN_SIZE
    } else if (block.type === 'document') {
      total += projectionDocumentTokens(block)
    }
  }
  return total
}

/**
 * Time-based microcompact / tool_result_clear, ported from official 2.1.284.
 * See the block comment above for semantics and the single structural
 * deviation. Returns null when every gate declines — the caller then falls
 * through to the legacy time-based / cached-MC paths unchanged.
 *
 * @param persist — the persist function (DI seam for tests; production uses
 *   utils/toolResultStorage.persistToolResult).
 */
export async function clearToolResultProjection(
  messages: Message[],
  querySource: QuerySource | undefined,
  persist?: ProjectionPersistFn,
): Promise<MemoryProjectionCleared | null> {
  // Main thread only — /compact, session_memory and agent forks inherit the
  // full conversation and must observe identical content (same predicate as
  // the legacy time-based path; keeps /compact semantics untouched).
  if (!querySource || !isMainThreadSource(querySource)) {
    return null
  }

  const compactableIds = collectCompactableToolIds(messages)
  // keepRecent counts whitelist tool_use ids: the last 5 stay untouched.
  // Exactly 5 whitelist results → nothing clearable → no-op.
  const keepSet = new Set(
    compactableIds.slice(-MEMORY_PROJECTION_KEEP_TOOL_USES),
  )
  const clearIdSet = new Set(compactableIds.filter(id => !keepSet.has(id)))
  if (clearIdSet.size === 0) {
    return null
  }

  const totalToolUses = collectTotalToolUseCount(messages)

  // Index Read-tool file paths (assistant tool_use input) for the
  // readFileState release contract.
  const readPathsById = new Map<string, string>()
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message!.content)
    ) {
      for (const block of message.message!.content) {
        if (block.type !== 'tool_use') continue
        if (block.name === FILE_READ_TOOL_NAME) {
          const input = (block.input ?? {}) as { file_path?: unknown }
          if (typeof input.file_path === 'string') {
            readPathsById.set(block.id, input.file_path)
          }
        }
      }
    }
  }

  // Official PLr preview (:4544): EVERY user-message tool_result block whose
  // id fell outside the keep window and is not already-cleared (zl) is a
  // candidate. Zero-token results (e.g. '') stay candidates — Hl just adds 0
  // — and duplicate ids keep one entry per block occurrence, exactly like
  // official (tokensSaved and persist both count blocks, not ids).
  const candidates: ToolResultBlockParam[] = []
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
      continue
    }
    for (const block of message.message!.content) {
      if (block.type !== 'tool_result' || !clearIdSet.has(block.tool_use_id)) {
        continue
      }
      if (isProjectionCleared(block.content)) continue
      candidates.push(block)
    }
  }
  if (candidates.length === 0) {
    return null
  }

  // Official single gate (_ALL.js:4544 `if (g < mun) return null`), computed
  // pre-persist over the GROSS preview Σ Hl. Strictly-less comparison means
  // g == 20000 EXACTLY proceeds and executes the clear (official boundary).
  // CCH's former post-persist net-basis second gate rejected this exact
  // boundary and is removed; the net figure is debug accounting only.
  const grossTokens = candidates.reduce(
    (sum, block) => sum + projectionToolResultTokens(block.content),
    0,
  )
  if (grossTokens < MEMORY_PROJECTION_MIN_TOKENS_SAVED) {
    return null
  }

  // Idle-pathway admission (pathway ①): measured for telemetry. Both pathways
  // funnel through the same official gross 20k floor above, which dominates
  // pathway ①'s extra floors — see block comment, admission note.
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  const gapMs = lastAssistant
    ? Date.now() -
      new Date(lastAssistant.timestamp as string | number).getTime()
    : Number.POSITIVE_INFINITY
  const idleAdmitted =
    Number.isFinite(gapMs) &&
    gapMs > MEMORY_PROJECTION_MIN_IDLE_MS &&
    totalToolUses >= MEMORY_PROJECTION_MIN_TOTAL_TOOL_USES &&
    candidates.length >= MEMORY_PROJECTION_MIN_CLEARABLE

  const { buildLargeToolResultMessage, isPersistError } = getToolResultStorage()
  const doPersist: ProjectionPersistFn =
    persist ??
    ((content, toolUseId) =>
      getToolResultStorage().persistToolResult(content, toolUseId))

  // Official :4544 lMo persist phase — P = content ? persist(content,id) :
  // null, then E[id] = P ?? Ct. CONTENT TRUTHINESS (not the visual split)
  // decides whether persist runs: arrays are always truthy, so image/document
  // content reaches persist exactly like official (the real persist path
  // rejects non-text blocks there and we fall back to the literal), while
  // ''/falsy content skips persist and lands on the bare literal directly.
  const contentById = new Map<string, string>()
  for (const candidate of candidates) {
    const content = candidate.block.content
    if (content) {
      const persisted = await doPersist(content, candidate.block.tool_use_id)
      contentById.set(
        candidate.block.tool_use_id,
        isPersistError(persisted)
          ? TIME_BASED_MC_CLEARED_MESSAGE
          : buildLargeToolResultMessage(persisted),
      )
    } else {
      contentById.set(
        candidate.block.tool_use_id,
        TIME_BASED_MC_CLEARED_MESSAGE,
      )
    }
  }

  // Official :4544 EFt projection — per tool_result block whose id has a
  // candidate: visual content → the bare literal; else the persisted preview
  // (E[id] ?? Ct); wrap ONCE with the official Tt prefix when the ORIGINAL
  // content carries the artifact-authored marker; a block whose content is
  // already byte-identical to its replacement stays untouched.
  const clearedReplacements = new Map<string, string>()
  let netTokensSaved = 0
  const projectionMessages: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
      return message
    }
    let touched = false
    const newContent = message.message!.content.map(block => {
      if (block.type !== 'tool_result' || !contentById.has(block.tool_use_id)) {
        return block
      }
      const visual = hasImageOrDocumentBlock(block.content)
      let replacement = visual
        ? TIME_BASED_MC_CLEARED_MESSAGE
        : (contentById.get(block.tool_use_id) ?? TIME_BASED_MC_CLEARED_MESSAGE)
      if (
        !visual &&
        !replacement.startsWith(ARTIFACT_CONTENT_MARKER_PREFIX) &&
        contentIncludesArtifactMarker(block.content)
      ) {
        replacement = ARTIFACT_CONTENT_MARKER_PREFIX + replacement
      }
      if (block.content === replacement) return block
      touched = true
      netTokensSaved +=
        projectionToolResultTokens(block.content) -
        projectionToolResultTokens(replacement)
      clearedReplacements.set(block.tool_use_id, replacement)
      return { ...block, content: replacement }
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  if (clearedReplacements.size === 0) {
    return null
  }

  const readFileStatePaths = [...clearedReplacements.keys()]
    .map(id => readPathsById.get(id))
    .filter((p): p is string => typeof p === 'string')

  logEvent('tengu_memory_projection_clear', {
    toolsCleared: clearedReplacements.size,
    toolsKept: Math.min(
      compactableIds.length,
      MEMORY_PROJECTION_KEEP_TOOL_USES,
    ),
    totalToolUses,
    // Official :4544 telemetry basis — tokensSaved IS the gross preview Σ Hl
    // (g); the net figure is debug accounting only.
    tokensSaved: grossTokens,
    grossTokens,
    idleAdmitted,
    gapMinutes: Number.isFinite(gapMs) ? Math.round(gapMs / 60_000) : -1,
  })

  logForDebugging(
    `[MEMORY_PROJECTION] cleared ${clearedReplacements.size} tool results ` +
      `(~${grossTokens} tokens, net ${netTokensSaved}, idle=${idleAdmitted}), ` +
      `kept last ${MEMORY_PROJECTION_KEEP_TOOL_USES}`,
  )

  suppressCompactWarning()
  // Same stale-state reasoning as the legacy time-based path: cached-MC holds
  // tool ids whose content we just changed — reset it.
  resetMicrocompactState()
  // Prompt content changed → the next cache read will drop; tell the break
  // detector it was us (only meaningful on the first-party path).
  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    notifyCacheDeletion(querySource)
  }

  return {
    messages: projectionMessages,
    clearedToolUseIds: [...clearedReplacements.keys()],
    clearedReplacements,
    readFileStatePaths,
    // Official basis: gross preview Σ Hl (g), matching the :4544 telemetry.
    tokensSaved: grossTokens,
  }
}

/**
 * Sync the applied projection into the REPL-owned mutable message list so the
 * original tool_result content strings can be garbage collected (official UI
 * contract: "local message list is synchronously replaced", no inline hint).
 *
 * Performs an IN-PLACE block swap inside the existing content arrays: the
 * message objects' identity is preserved (React holds the same references and
 * re-renders read toolUseResult, which is untouched), and the transcript is
 * safe because recordTranscript skips already-uuid-recorded messages.
 */
export function syncProjectionToMutableMessages(
  mutableMessages: Message[],
  replacements: ReadonlyMap<string, string>,
): void {
  for (const message of mutableMessages) {
    if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
      continue
    }
    const content = message.message!.content
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (block.type !== 'tool_result') continue
      const replacement = replacements.get(block.tool_use_id)
      if (replacement === undefined || block.content === replacement) continue
      content[i] = { ...block, content: replacement }
    }
  }
}
