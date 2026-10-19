/**
 * Lifecycle hook event trio (work package W7, task #58 block 3).
 *
 * Registers PreModelSwitch / PostModelSwitch / UserPromptExpansion on the
 * hooks-management surface, alongside the settings-era HOOK_EVENTS enum
 * (PreToolUse et al., src/entrypoints/sdk/coreTypes.ts + coreSchemas.ts).
 * Touching the SDK enum would regen coreTypes.generated.js, which sits
 * outside this work package's file whitelist — so the trio extends the same
 * face here with a merged event-name accessor instead.
 *
 * Official anchors (decompiled):
 *   - 0009-chunk-j18026mh/module-004-uncategorized.js:686 — both
 *     PreModelSwitch/PostModelSwitch enumerated directly after PostCompact in
 *     the hook-registry map, same position as coreTypes' HOOK_EVENTS.
 *   - 0004-chunk-zrkp23rq/module-005-uncategorized.js:698/3843 —
 *     PreModelSwitch supports permissionDecision allow/deny/ask ("Same
 *     contract as PreToolUse: allow proceeds…deny cancels the switch");
 *     PostModelSwitch/UserPromptExpansion carry additionalContext, with
 *     suppressOriginalPrompt for UserPromptExpansion blocks.
 *   - 0010-chunk-k40f9rxb/permissions/checker.js:65 — UserPromptExpansion
 *     block output shape (decision/reason/hookSpecificOutput).
 *
 * Emission sites:
 *   - bridge control "set_model" → emitPreModelSwitch/emitPostModelSwitch
 *     (src/bridge/bridgeMessaging.ts).
 *   - bridge SSE ingress of a remote user prompt → emitUserPromptExpansion
 *     payload for the expanded prompt entering the session (BRIDGE INBOUND
 *     ONLY — the local prompt path does not emit; see bridgeMessaging.ts).
 *   - local /model command switch → emitPreModelSwitch/emitPostModelSwitch
 *     (src/commands/model/model.tsx, source 'command').
 *   - SDK -p set_model control request → same emitters (src/cli/print.ts,
 *     source 'sdk').
 *   - API fallback switch mid-turn → same emitters, source 'auto'
 *     (src/query.ts FallbackTriggeredError branch; official any-cause
 *     PostModelSwitch contract, 0461 anchor below).
 *
 * Observability-only downgrade (R7, declared): the official PreModelSwitch
 * contract allows a deny permissionDecision to CANCEL the switch. The emitters
 * here are fire-and-forget void — no verdict is returned to any caller, so
 * registered hooks observe but cannot block a model switch on these paths.
 *
 * Deny observability (W7 round 2, item 5): handlers may still RETURN their
 * official verdicts (PreModelSwitch permissionDecision deny/ask; generic
 * `decision: "block"` — 0004-chunk-zrkp23rq/module-005-uncategorized.js:3843).
 * The emitters cannot honor them (above), but they no longer vanish: each
 * deny-style verdict is logged (debug face) and counted — both in a
 * process-local counter (`getDiscardedLifecycleVerdictCounts`) and by a
 * numeric tengu event (`tengu_lifecycle_hook_verdict_discarded`).
 */

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../debug.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  dispatchMainThreadHookEvent,
  registerMainThreadHook,
  type MainThreadHookDispatchResult,
  type MainThreadHookHandler,
} from './hookRegistry.js'

export const PRE_MODEL_SWITCH_EVENT = 'PreModelSwitch'
export const POST_MODEL_SWITCH_EVENT = 'PostModelSwitch'
export const USER_PROMPT_EXPANSION_EVENT = 'UserPromptExpansion'

/** The trio, in official registry-map order (post-compact slot). */
export const LIFECYCLE_HOOK_EVENTS = [
  PRE_MODEL_SWITCH_EVENT,
  POST_MODEL_SWITCH_EVENT,
  USER_PROMPT_EXPANSION_EVENT,
] as const

export type LifecycleHookEvent = (typeof LIFECYCLE_HOOK_EVENTS)[number]

// Local runtime copy of the settings-era enum so this module stays
// SDK-import-light; mirrors src/entrypoints/sdk/coreTypes.ts HOOK_EVENTS.
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

/** HOOK_EVENTS ∪ lifecycle trio — the event-name face settings/config UIs see. */
export type ExtendedHookEvent = HookEvent | LifecycleHookEvent

export function isLifecycleHookEvent(name: string): name is LifecycleHookEvent {
  return (LIFECYCLE_HOOK_EVENTS as readonly string[]).includes(name)
}

export function isExtendedHookEventName(name: string): boolean {
  return (
    (LIFECYCLE_HOOK_EVENTS as readonly string[]).includes(name) ||
    (HOOK_EVENTS as readonly string[]).includes(name)
  )
}

/** Convenience — register a hook against one or more lifecycle events. */
export function registerLifecycleHook(params: {
  name: string
  events: readonly LifecycleHookEvent[]
  origin?: 'local' | 'plugin'
  callback: MainThreadHookHandler
}): string {
  return registerMainThreadHook(params)
}

// ============================================================================
// Built-in registrant (R7 #58) — guarantees dispatch is never vacuous
// ============================================================================

let builtinHookIds: string[] | null = null

// ============================================================================
// Discarded-verdict observability (W7 round 2, item 5)
// ============================================================================

/** Per-event count of deny-style verdicts that were logged and discarded. */
const discardedVerdictCounts: Record<string, number> = {}

/** Snapshot of the discarded-verdict counters (event_log face, in-memory). */
export function getDiscardedLifecycleVerdictCounts(): Record<string, number> {
  return { ...discardedVerdictCounts }
}

/** Test seam — zero the discarded-verdict counters. */
export function resetDiscardedLifecycleVerdictCountsForTest(): void {
  for (const key of Object.keys(discardedVerdictCounts)) {
    delete discardedVerdictCounts[key]
  }
}

/**
 * A verdict that, per the official hook output schema, would change the
 * event's outcome: PreModelSwitch permissionDecision deny/ask (0004:3843)
 * or the generic decision:"block". PostModelSwitch carries additionalContext
 * only and has no deny face.
 */
function isDenyStyleVerdict(verdict: Record<string, unknown>): boolean {
  const permissionDecision = verdict['permissionDecision']
  if (permissionDecision === 'deny' || permissionDecision === 'ask') {
    return true
  }
  return verdict['decision'] === 'block'
}

/**
 * Make deny-style verdicts observable without enforcing them: one debug line
 * per verdict (the exact outcome the hook wanted, quote-embedded) plus a
 * counter bump on both the numeric tengu face and the process-local
 * counters. Never throws into the emit path.
 */
function logDiscardedVerdicts(
  event: string,
  results: readonly MainThreadHookDispatchResult[],
): void {
  const denied = results.filter(result => isDenyStyleVerdict(result.verdict))
  if (denied.length === 0) return
  for (const result of denied) {
    let rendered: string
    try {
      rendered = JSON.stringify(result.verdict)
    } catch {
      rendered = '[unserializable verdict]'
    }
    logForDebugging(
      `[lifecycleHooks] ${event} verdict from ${result.hook} DISCARDED ` +
        `(observability-only downgrade — a deny here does not cancel): ${rendered}`,
    )
  }
  discardedVerdictCounts[event] =
    (discardedVerdictCounts[event] ?? 0) + denied.length
  // Numeric-only metadata (analytics face forbids string values).
  logEvent('tengu_lifecycle_hook_verdict_discarded', {
    [event]: denied.length,
  })
}

/**
 * Registers one real main-thread hook per lifecycle event (a debug
 * observability sink) exactly once per process. R7 review: before this, the
 * registry had zero registrants, so every dispatchMainThreadHookEvent was
 * statically empty. The built-in hook keeps dispatch behaviorally real
 * (the payload digest lands in the debug log) until programmatic or
 * settings-driven consumers register their own hooks.
 */
export function ensureBuiltinLifecycleHookRegistered(): string[] {
  if (builtinHookIds) return builtinHookIds
  builtinHookIds = LIFECYCLE_HOOK_EVENTS.map(event =>
    registerMainThreadHook({
      name: `lifecycle-builtin-logger:${event}`,
      events: [event],
      origin: 'local',
      callback: payload => {
        logForDebugging(
          `[lifecycleHooks] ${event} dispatched: ${Object.keys(payload).join(', ') || '(no payload)'}`,
        )
      },
    }),
  )
  return builtinHookIds
}

/** Test seam — forget the registered built-in hook ids so ensure… registers
 * afresh (mirrors resetMainThreadHookRegistry teardown). */
export function resetBuiltinLifecycleHookForTest(): void {
  builtinHookIds = null
}

/**
 * Fired before a model switch applies. deny-style outcomes belong to the
 * caller's policy callback (see official permissionDecision contract);
 * this emitter is observability-first.
 *
 * Observability-only (R7, declared): the official contract lets a deny
 * decision cancel the switch, but this face is fire-and-forget — hooks
 * observe, they cannot block. No caller reads a verdict back.
 */
export async function emitPreModelSwitch(payload: {
  fromModel?: string | null
  toModel?: string | null
  source?: 'command' | 'picker' | 'sdk' | 'auto' | 'resume'
}): Promise<void> {
  ensureBuiltinLifecycleHookRegistered()
  const results = await dispatchMainThreadHookEvent(PRE_MODEL_SWITCH_EVENT, {
    ...payload,
  })
  logDiscardedVerdicts(PRE_MODEL_SWITCH_EVENT, results)
  logForDebugging(
    `[lifecycleHooks] PreModelSwitch ${payload.fromModel ?? '?'} → ${payload.toModel ?? '?'}`,
  )
}

/** Fired after a model switch has been applied. */
export async function emitPostModelSwitch(payload: {
  fromModel?: string | null
  toModel?: string | null
  source?: 'command' | 'picker' | 'sdk' | 'auto' | 'resume'
}): Promise<void> {
  ensureBuiltinLifecycleHookRegistered()
  // PostModelSwitch has no deny face (additionalContext only), but a
  // decision:"block" verdict from an overreaching hook is still made
  // observable rather than silently dropped.
  const results = await dispatchMainThreadHookEvent(POST_MODEL_SWITCH_EVENT, {
    ...payload,
  })
  logDiscardedVerdicts(POST_MODEL_SWITCH_EVENT, results)
  logForDebugging(
    `[lifecycleHooks] PostModelSwitch → ${payload.toModel ?? '?'}`,
  )
}

/**
 * Fired when an (expanded) user prompt enters the session. Mirrors the
 * official UserPromptExpansion output fields (additionalContext /
 * suppressOriginalPrompt) in the payload so blocking consumers can act on
 * them without reshaping. Current emission is bridge-inbound only (see the
 * file header) — payload fields other than original/expanded stay unset.
 */
export async function emitUserPromptExpansion(payload: {
  originalPrompt: string
  expandedPrompt: string
  additionalContext?: string
  suppressOriginalPrompt?: boolean
}): Promise<void> {
  ensureBuiltinLifecycleHookRegistered()
  const results = await dispatchMainThreadHookEvent(
    USER_PROMPT_EXPANSION_EVENT,
    {
      ...payload,
    },
  )
  logDiscardedVerdicts(USER_PROMPT_EXPANSION_EVENT, results)
}
