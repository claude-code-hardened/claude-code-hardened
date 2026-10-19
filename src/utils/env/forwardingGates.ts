/**
 * Forwarding kill-switches (work package W7, task #58 block 4).
 *
 * Official anchors:
 *   - CLAUDE_CODE_DISABLE_HOOK_FORWARDING — 0037-chunk-bxerm1mk
 *     module-005-uncategorized.js: BGt() = platform-ok && hook-forward
 *     capable && !env. When set, handleForwardedHook paths are inert.
 *   - CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING — 0001-chunk-xrzcaagk
 *     module-006-uncategorized.js: plugin-forward worker's isEnabled() adds
 *     `&& !env`; 0010-chunk-k40f9rxb telemetry logs
 *     `plugin_forwarding_worker_disabled` with reason "disabled".
 *
 * Both default to forwarding ENABLED (gate off) — the env vars are opt-out
 * kill switches, not opt-in flags.
 */

import { isEnvTruthy } from '../envUtils.js'

/** True when relaying hook executions to/from remote sessions is disabled. */
export function isHookForwardingDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_HOOK_FORWARDING)
}

/** Inverse convenience for `&& isHookForwardingEnabled()` style gates. */
export function isHookForwardingEnabled(): boolean {
  return !isHookForwardingDisabled()
}

/** True when forwarding plugin-provided hooks is disabled. */
export function isPluginForwardingDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING)
}

/** Inverse convenience for `&& isPluginForwardingEnabled()` style gates. */
export function isPluginForwardingEnabled(): boolean {
  return !isPluginForwardingDisabled()
}
