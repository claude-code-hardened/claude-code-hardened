/**
 * Main-thread hook registry (work package W7, task #58 block 2).
 *
 * An in-process registry for main-loop lifecycle hooks, in the same spirit as
 * the post-sampling hook registry (`postSamplingHooks.ts`) but with the full
 * register / replace / clear API surface.
 *
 * ARCHITECTURE DEBT (W7 round 2, declared): this registry and the
 * settings-driven hook matchers (`hooksSettings.ts`, `sessionHooks.ts` — the
 * `settings.json` "hooks" pipe that execs shell/HTTP/prompt hooks) COEXIST
 * WITHOUT SEMANTIC INTEROP. Entries here never flow into the settings pipe
 * and settings hooks never flow into this registry; the two share event
 * *names* but not configuration, matching, or delivery guarantees. Anything
 * registered programatically (bridge, SDK faces, the lifecycle trio) is only
 * reachable via dispatchMainThreadHookEvent — not via `settings.json` hooks.
 *
 * Forwarding semantics (block 4): entries may declare which origins they
 * accept. When CLAUDE_CODE_DISABLE_HOOK_FORWARDING is set, events marked as
 * forwarded (relayed from a remote/bridge session) are dropped; when
 * CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING is set, plugin-origin entries are
 * skipped for forwarded events. Locally-originated dispatch is never gated —
 * the kill switches must not break the local loop.
 *
 * `forwarded` is RESERVED FOR PEER FORWARDING (NOT WIRED): no production
 * emission site passes `forwarded: true` today (only tests do). The gate is
 * a quarantine layer for a remote-peer relay that has not been built.
 */

import { toError } from '../errors.js'
import { logError } from '../log.js'
import {
  isHookForwardingDisabled,
  isPluginForwardingDisabled,
} from '../env/forwardingGates.js'
import { logForDebugging } from '../debug.js'

export type MainThreadHookOrigin = 'local' | 'plugin'

/**
 * A handler may return a structured verdict (e.g. PreModelSwitch's
 * permissionDecision allow/deny/ask per the official hook output schema,
 * 0004-chunk-zrkp23rq/module-005-uncategorized.js:3843). Returning a value is
 * how a handler makes its decision OBSERVABLE; it does not change dispatch —
 * the lifecycle emitters decide what to do with verdicts (they log discarded
 * deny-style verdicts, see lifecycleHookEvents.ts).
 */
export type MainThreadHookVerdict = Record<string, unknown>

export type MainThreadHookHandler = (
  payload: Record<string, unknown>,
) =>
  | undefined
  | MainThreadHookVerdict
  | Promise<MainThreadHookVerdict | undefined>

export type MainThreadHookDispatchResult = {
  /** The hook that produced the verdict. */
  hook: string
  id: string
  /** The returned verdict object. */
  verdict: MainThreadHookVerdict
}

export type MainThreadHook = {
  /** Stable id (returned by registerMainThreadHook, used by replace/remove). */
  id: string
  /** Human-readable name for debug logs. */
  name: string
  /** Event names this hook reacts to. */
  events: readonly string[]
  /** Where the hook came from — plugin hooks obey the plugin-forwarding gate. */
  origin?: MainThreadHookOrigin
  callback: MainThreadHookHandler
}

export type DispatchMainThreadHookEventOptions = {
  /**
   * True when the event was relayed from a remote/bridge session. Forwarded
   * dispatch honors both forwarding kill switches. RESERVED (not wired):
   * no production caller sets this yet — see the header note.
   */
  forwarded?: boolean
}

const registry = new Map<string, MainThreadHook>()
let nextHookOrdinal = 0

function nextHookId(): string {
  nextHookOrdinal += 1
  return `main-thread-hook-${nextHookOrdinal}-${Date.now()}`
}

/**
 * Register a main-thread hook. `replace`-style re-registration of the same
 * id (upsert) is supported via replaceMainThreadHook.
 */
export function registerMainThreadHook(
  hook: Omit<MainThreadHook, 'id'> & { id?: string },
): string {
  const id = hook.id ?? nextHookId()
  registry.set(id, { ...hook, id })
  logForDebugging(
    `[hookRegistry] Registered ${hook.name} (${id}) for events: ${hook.events.join(', ')}`,
  )
  return id
}

/** Replace (upsert) an existing hook by id. Returns false when id is unknown. */
export function replaceMainThreadHook(
  id: string,
  next: Partial<Omit<MainThreadHook, 'id'>>,
): boolean {
  const existing = registry.get(id)
  if (!existing) return false
  registry.set(id, { ...existing, ...next, id })
  return true
}

/** Remove a single hook by id. Returns true when something was removed. */
export function removeMainThreadHook(id: string): boolean {
  return registry.delete(id)
}

/**
 * Clear registered hooks — all of them, or only those listening to a given
 * event. Returns the number of hooks removed.
 */
export function clearMainThreadHooks(event?: string): number {
  if (event === undefined) {
    const count = registry.size
    registry.clear()
    return count
  }
  let removed = 0
  for (const [id, hook] of registry) {
    if (hook.events.includes(event)) {
      registry.delete(id)
      removed += 1
    }
  }
  return removed
}

/** Snapshot of hooks listening to an event (registration order). */
export function getMainThreadHooks(event: string): MainThreadHook[] {
  const hooks: MainThreadHook[] = []
  for (const hook of registry.values()) {
    if (hook.events.includes(event)) hooks.push(hook)
  }
  return hooks
}

export function hasMainThreadHooks(event: string): boolean {
  return getMainThreadHooks(event).length > 0
}

/** Test/teardown helper — empties the registry and returns the removed count. */
export function resetMainThreadHookRegistry(): number {
  const count = registry.size
  registry.clear()
  return count
}

/**
 * Single dispatch consumption point. Fires every hook registered for the
 * event (serially, awaited). A hook error is logged and does not break the
 * remaining dispatch — mirrors executePostSamplingHooks.
 *
 * Returns the verdicts returned by handlers (skipping void). The caller —
 * the lifecycle emitters — decides what a verdict means; this registry only
 * relays it.
 */
export async function dispatchMainThreadHookEvent(
  event: string,
  payload: Record<string, unknown> = {},
  options: DispatchMainThreadHookEventOptions = {},
): Promise<MainThreadHookDispatchResult[]> {
  const forwarded = options.forwarded === true
  const hooks = getMainThreadHooks(event)
  const dispatchResults: MainThreadHookDispatchResult[] = []
  for (const hook of hooks) {
    // Forward-gating converged into a single skip decision: the event-level
    // hook kill switch applies to every hook, the plugin-origin gate only to
    // plugin entries. Local dispatch is never gated.
    if (forwarded) {
      const hookGateHits = isHookForwardingDisabled()
      const pluginGateHits =
        hook.origin === 'plugin' && isPluginForwardingDisabled()
      if (hookGateHits || pluginGateHits) {
        // Precedence note: when both gates are set the hook-level gate is
        // the one that dropped the dispatch (checked first).
        const byHookGate = hookGateHits || !pluginGateHits
        logForDebugging(
          `[hookRegistry] Skipped ${byHookGate ? '' : 'plugin hook '}${hook.name} for forwarded ${event}: ${byHookGate ? 'hook' : 'plugin'} forwarding disabled`,
        )
        continue
      }
    }
    try {
      const verdict = await hook.callback(payload)
      if (verdict && typeof verdict === 'object') {
        dispatchResults.push({ hook: hook.name, id: hook.id, verdict })
      }
    } catch (error) {
      logError(toError(error))
    }
  }
  return dispatchResults
}
