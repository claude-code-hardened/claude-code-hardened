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
 *
 * Observability-only downgrade (R7, declared): the official PreModelSwitch
 * contract allows a deny permissionDecision to CANCEL the switch. The emitters
 * here are fire-and-forget void — no verdict is returned to any caller, so
 * registered hooks observe but cannot block a model switch on these paths.
 */

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../debug.js'
import {
  dispatchMainThreadHookEvent,
  registerMainThreadHook,
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
  await dispatchMainThreadHookEvent(PRE_MODEL_SWITCH_EVENT, { ...payload })
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
  await dispatchMainThreadHookEvent(POST_MODEL_SWITCH_EVENT, { ...payload })
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
  await dispatchMainThreadHookEvent(USER_PROMPT_EXPANSION_EVENT, {
    ...payload,
  })
}
