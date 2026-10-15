import { feature } from 'bun:bundle'
import { logEvent } from '../analytics/index.js'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import {
  getCurrentUsage,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
  // 2.9 (official 2.1.284): consecutive "refilled to the autocompact
  // threshold within <RAPID_REFILL_TURN_WINDOW turns of the previous
  // compact" count. Circuits open at MAX_CONSECUTIVE_RAPID_REFILLS.
  // Independent of consecutiveFailures — that breaker counts FAILURES,
  // this one counts successful compacts that immediately refill
  // (thrashing). Officially threaded across a compact via twr.
  consecutiveRapidRefills?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// Conservative estimate for tool result growth per turn.
// Typical tool results (file reads, grep, bash) average ~5-10K tokens;
// occasional large reads can spike to 20K+.
const TOOL_RESULT_GROWTH_ESTIMATE = 15_000

/**
 * Context-aware autocompact buffer. Larger context windows need more
 * headroom because a single turn can produce proportionally more tokens
 * (longer model outputs + larger tool results).
 */
export function getAutocompactBufferTokens(model: string): number {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  if (effectiveWindow >= 800_000) return 50_000
  if (effectiveWindow >= 400_000) return 30_000
  return AUTOCOMPACT_BUFFER_TOKENS
}

/**
 * Estimate the maximum token growth a single turn can produce.
 * Used for predictive autocompact checks before the API call.
 */
export function estimateMaxTurnGrowth(model: string): number {
  const maxOutput = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return maxOutput + TOOL_RESULT_GROWTH_ESTIMATE
}

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// ---------------------------------------------------------------------------
// 2.9 — official 2.1.284 autocompact protections (both gated behind the
// AUTO_COMPACT_BREAKER feature flag; flag off → behavior byte-identical to
// pre-2.9). All constants below are extracted from the official bundle
// (docs/reverse-284/full-source/_ALL.js), byte offsets cited inline.
//
// Coexistence with 2.1 MEMORY_PROJECTION (flags all on), per query-loop
// iteration order in query.ts: snip → deps.microcompact (time-based tool
// result clear + projection release — microCompactMessages is untouched by
// 2.9) → context collapse → deps.autocompact → [prefix-overflow precheck →
// rapid-refill breaker → session-memory probe → legacy compact]. The refill
// evaluation sees the POST-microcompact array, so projection-cleared tool
// results shrink the effective refill and keep the counter lower — the
// mechanisms compose without reordering.
// ---------------------------------------------------------------------------

// Official 2.1.284 byte 8681495: `var qct=3` (rendered "<${qct} turns each"
// in the trip log), and kNn's literal `e.turnCounter<3`. A compact whose
// context returns to the autocompact threshold within this many loop
// iterations counts as a refill.
export const RAPID_REFILL_TURN_WINDOW = 3

// Official 2.1.284 byte 8681595, lFn literal: `{action:n>=3?"trip":"proceed"}`.
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3

// Official 2.1.284 byte 8681801, var nwr — yielded verbatim by the query
// loop's kind==="rapid_refill_breaker_tripped" branch (byte 15516528).
export const AUTOCOMPACT_THRASHING_ERROR_MESSAGE =
  'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.'

export type PrefixOverflowCheck = {
  // Estimated fixed-prefix tokens: usage-derived request total minus the
  // message content estimate minus snipTokensFreed. This is the part of the
  // request compaction cannot shrink (system prompt, tool defs, MCP tools).
  prefixTokens: number
  thresholdTokens: number
  totalInputTokens: number
  messagesEstimate: number
  snipTokensFreed: number
  documentBlockCount: number
  imageBlockCount: number
}

/**
 * 2.9 prefix-overflow precheck — port of official 2.1.284 Oko
 * (byte 9533058): `let g=Pke(e);if(!g)return null;let
 * h=g.input_tokens+g.cache_read_input_tokens+g.cache_creation_input_tokens,
 * S=xm(e,n.bytesPerToken),w=Math.max(0,h-s-S),D=CKe(n,r);if(w<=D)return
 * null;...return{prefixTokens:w,thresholdTokens:D,totalInputTokens:h,
 * messagesEstimate:S,snipTokensFreed:s,documentBlockCount:U,imageBlockCount:W}`.
 * Pure: null means "compaction can still help"; non-null means the fixed
 * prefix alone already exceeds the autocompact threshold.
 */
export function detectPrefixOverflow(input: {
  totalInputTokens: number
  messagesEstimate: number
  thresholdTokens: number
  snipTokensFreed?: number
  documentBlockCount?: number
  imageBlockCount?: number
}): PrefixOverflowCheck | null {
  const prefixTokens = Math.max(
    0,
    input.totalInputTokens -
      (input.snipTokensFreed ?? 0) -
      input.messagesEstimate,
  )
  if (prefixTokens <= input.thresholdTokens) {
    return null
  }
  return {
    prefixTokens,
    thresholdTokens: input.thresholdTokens,
    totalInputTokens: input.totalInputTokens,
    messagesEstimate: input.messagesEstimate,
    snipTokensFreed: input.snipTokensFreed ?? 0,
    documentBlockCount: input.documentBlockCount ?? 0,
    imageBlockCount: input.imageBlockCount ?? 0,
  }
}

// Official Oko's media counters (byte 9533058): documents whose source is
// neither text nor content (PDFs etc.) and images, recursing into
// tool_result content arrays. Telemetry payload only.
function countOverflowMediaBlocks(
  content: unknown,
  counts: { documentBlockCount: number; imageBlockCount: number },
): void {
  if (!Array.isArray(content)) return
  for (const raw of content) {
    const block = raw as {
      type?: string
      source?: { type?: string }
      content?: unknown
    }
    if (
      block.type === 'document' &&
      block.source?.type !== 'text' &&
      block.source?.type !== 'content'
    ) {
      counts.documentBlockCount++
    } else if (block.type === 'image') {
      counts.imageBlockCount++
    } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
      countOverflowMediaBlocks(block.content, counts)
    }
  }
}

function gatherPrefixOverflowMediaBlocks(messages: readonly Message[]): {
  documentBlockCount: number
  imageBlockCount: number
} {
  const counts = { documentBlockCount: 0, imageBlockCount: 0 }
  for (const message of messages) {
    countOverflowMediaBlocks(message.message?.content, counts)
  }
  return counts
}

/**
 * 2.9: assemble the inputs for detectPrefixOverflow from live state.
 * CCH's roughTokenCountEstimationForMessages stands in for official
 * xm(e, n.bytesPerToken); getCurrentUsage for Pke(e) (skips zero-placeholder
 * usage rows); getAutoCompactThreshold for CKe.
 */
function buildPrefixOverflowCheck(
  messages: Message[],
  model: string,
  snipTokensFreed?: number,
): PrefixOverflowCheck | null {
  // Official Oko returns null when no usage-bearing message exists — no
  // server-reported baseline means the estimate cannot separate the fixed
  // prefix from the compactable tail.
  const usage = getCurrentUsage(messages)
  if (!usage) return null
  const media = gatherPrefixOverflowMediaBlocks(messages)
  return detectPrefixOverflow({
    totalInputTokens:
      usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens,
    messagesEstimate: roughTokenCountEstimationForMessages(messages),
    thresholdTokens: getAutoCompactThreshold(model),
    snipTokensFreed: snipTokensFreed ?? 0,
    documentBlockCount: media.documentBlockCount,
    imageBlockCount: media.imageBlockCount,
  })
}

/**
 * 2.9 rapid-refill counter — port of official 2.1.284 kNn (byte 8681566):
 * `return e?.compacted===!0&&e.turnCounter<3?(e?.consecutiveRapidRefills??0)+1:0`.
 * tracking.compacted is the loop's "the previous compact succeeded" flag and
 * turnCounter the completed iterations since it (query.ts increments it in
 * the post-tools section), so "compacted and back at the threshold within
 * <3 iterations" is exactly a refill.
 */
export function computeConsecutiveRapidRefills(
  tracking?: AutoCompactTrackingState,
): number {
  return tracking?.compacted === true &&
    tracking.turnCounter < RAPID_REFILL_TURN_WINDOW
    ? (tracking.consecutiveRapidRefills ?? 0) + 1
    : 0
}

/**
 * 2.9 rapid-refill breaker — port of official 2.1.284 lFn (byte 8681595):
 * `function lFn(e){let n=kNn(e);return{action:n>=3?"trip":"proceed",
 * consecutiveRapidRefills:n}}`. Independent of the consecutiveFailures
 * breaker: it opens on REPEATED SUCCESSFUL compacts that refill, not on
 * compaction failures.
 */
export function evaluateRapidRefillBreaker(
  tracking?: AutoCompactTrackingState,
): {
  action: 'proceed' | 'trip'
  consecutiveRapidRefills: number
} {
  const consecutiveRapidRefills = computeConsecutiveRapidRefills(tracking)
  return {
    action:
      consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS
        ? 'trip'
        : 'proceed',
    consecutiveRapidRefills,
  }
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    effectiveContextWindow - getAutocompactBufferTokens(model)

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  // 2.9: threaded on successful compacts under AUTO_COMPACT_BREAKER so the
  // caller can re-arm tracking with the pre-compact refill count (official
  // byte 15517958: Ze=twr(A.uuid(),Qt.consecutiveRapidRefills)).
  consecutiveRapidRefills?: number
  // 2.9: present when the rapid-refill breaker tripped — the caller yields
  // the thrashing API error message and ends the loop (official kind
  // "rapid_refill_breaker_tripped", byte 15516528).
  rapidRefillBreaker?: {
    consecutiveRapidRefills: number
    turnsSincePreviousCompact: number
  }
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  // -- 2.9: official 2.1.284 autocompact protections (flag-gated) -----------
  // Guard order mirrors the official autocompact generator (byte 9533695):
  // consecutiveFailures breaker (above) → threshold check (shouldAutoCompact)
  // → prefix-overflow precheck → rapid-refill breaker → compaction. Flag
  // off → this block is skipped entirely and behavior is byte-identical to
  // pre-2.9 (the new result keys are only ever present under the flag).
  let consecutiveRapidRefills: number | undefined
  if (feature('AUTO_COMPACT_BREAKER')) {
    // (1) Prefix-overflow precheck. NOTE on official parity: 2.1.284 ships
    // this as shadow telemetry only — it computes Oko, logs
    // tengu_auto_compact_prefix_overflow with wouldHaveBlocked:!0 (byte
    // 9534597) and then falls through into the compact anyway. CCH
    // activates the behavior the shadow arm was measuring: when the fixed
    // prefix (server-reported request total minus message estimate minus
    // snipTokensFreed — i.e. system prompt + tool defs + non-compactable
    // context) alone exceeds the threshold, no compaction can fit, so
    // return without attempting one. The API call runs and surfaces
    // prompt-too-long through the usual paths (reactiveCompact /
    // blocking-limit preempt — both consult state downstream of this
    // return, see query.ts).
    const overflow = buildPrefixOverflowCheck(messages, model, snipTokensFreed)
    if (overflow) {
      logForDebugging(
        `autocompact: fixed prefix ~${overflow.prefixTokens} > threshold ${overflow.thresholdTokens} — compaction cannot help`,
        { level: 'warn' },
      )
      // Same event name + payload shape as official (byte 9534597);
      // wouldHaveBlocked keeps the official field name for dashboard parity.
      logEvent('tengu_auto_compact_prefix_overflow', {
        ...overflow,
        wouldHaveBlocked: true,
      })
      return { wasCompacted: false }
    }

    // (2) Rapid-refill breaker (official lFn, byte 8681595; trip log at
    // byte 9534953 emits kind "rapid_refill_breaker_tripped"). Fires on
    // consecutive compacts that refill within <3 iterations each — the
    // "successful but worthless compact" dimension orthogonal to the
    // consecutiveFailures breaker above. The session's threshold telemetry
    // (tengu_auto_compact_rapid_refill_breaker) is emitted by query.ts on
    // the same split official 2.1.284 uses (loop-side, byte 15516562).
    const refill = evaluateRapidRefillBreaker(tracking)
    consecutiveRapidRefills = refill.consecutiveRapidRefills
    if (refill.action === 'trip') {
      logForDebugging(
        `autocompact: rapid-refill breaker tripped — ${refill.consecutiveRapidRefills} consecutive refills within <${RAPID_REFILL_TURN_WINDOW} turns each (last was ${tracking?.turnCounter} turns)`,
        { level: 'warn' },
      )
      return {
        wasCompacted: false,
        rapidRefillBreaker: {
          consecutiveRapidRefills: refill.consecutiveRapidRefills,
          turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
        },
      }
    }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
      // 2.9: official twr keeps the refill counter across a successful
      // compact; the caller re-arms tracking with it. Flag off → undefined.
      ...(consecutiveRapidRefills !== undefined && {
        consecutiveRapidRefills,
      }),
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
      // 2.9: same refill-count threading as the session-memory path above.
      ...(consecutiveRapidRefills !== undefined && {
        consecutiveRapidRefills,
      }),
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
