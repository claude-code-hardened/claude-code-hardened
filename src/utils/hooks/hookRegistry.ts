/**
 * Main-thread hook registry (work package W7, task #58 block 2).
 *
 * An in-process registry for main-loop lifecycle hooks, in the same spirit as
 * the post-sampling hook registry (`postSamplingHooks.ts`) but with the full
 * register / replace / clear API surface. It is intentionally separate from
 * the settings-driven hook matchers (`hooksSettings.ts`, `sessionHooks.ts`):
 * entries here are programmatic, ephemeral, and dispatched synchronously by
 * the lifecycle emitters (`lifecycleHookEvents.ts` — the single consumption
 * point wired into the bridge model-switch and prompt-ingress paths).
 *
 * Forwarding semantics (block 4): entries may declare which origins they
 * accept. When CLAUDE_CODE_DISABLE_HOOK_FORWARDING is set, events marked as
 * forwarded (relayed from a remote/bridge session) are dropped; when
 * CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING is set, plugin-origin entries are
 * skipped for forwarded events. Locally-originated dispatch is never gated —
 * the kill switches must not break the local loop.
 */

import { toError } from '../errors.js'
import { logError } from '../log.js'
import {
  isHookForwardingDisabled,
  isPluginForwardingDisabled,
} from '../env/forwardingGates.js'
import { logForDebugging } from '../debug.js'

export type MainThreadHookOrigin = 'local' | 'plugin'

export type MainThreadHookHandler = (
  payload: Record<string, unknown>,
) => void | Promise<void>

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
   * dispatch honors both forwarding kill switches.
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
 */
export async function dispatchMainThreadHookEvent(
  event: string,
  payload: Record<string, unknown> = {},
  options: DispatchMainThreadHookEventOptions = {},
): Promise<void> {
  const forwarded = options.forwarded === true
  const hooks = getMainThreadHooks(event)
  for (const hook of hooks) {
    if (forwarded && isHookForwardingDisabled()) {
      logForDebugging(
        `[hookRegistry] Skipped ${hook.name} for forwarded ${event}: hook forwarding disabled`,
      )
      continue
    }
    if (forwarded && hook.origin === 'plugin' && isPluginForwardingDisabled()) {
      logForDebugging(
        `[hookRegistry] Skipped plugin hook ${hook.name} for forwarded ${event}: plugin forwarding disabled`,
      )
      continue
    }
    try {
      await hook.callback(payload)
    } catch (error) {
      logError(toError(error))
    }
  }
}
