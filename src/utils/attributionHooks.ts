/**
 * Attribution hooks module — forwarding layer over the attribution runtime
 * state owned by commitAttribution.ts (the file-content cache body and its
 * clear/sweep functions live there).
 *
 * Real consumers, all previously landing on empty stubs:
 * - src/services/compact/postCompactCleanup.ts — calls sweepFileContentCache()
 *   after every compaction (COMMIT_ATTRIBUTION feature) so cached file
 *   contents are actually released
 * - src/commands/clear/caches.ts — calls clearAttributionCaches() on /clear
 *   and --resume
 * - src/setup.ts — calls registerAttributionHooks() once at startup
 * Scope note: the official attribution module state singleton
 * (docs/reverse-284/decompiled/0054-chunk-dxsxk16b/
 * module-004-uncategorized.js:923, instantiated at :678) carries
 * `fileContentCache: new Map` and `hooksRegistered: !1` — both are restored
 * here (the cache body in commitAttribution.ts, the idempotence guard below).
 * The official PostToolUse hook plumbing that feeds trackFileModification()
 * (which tool payloads map to old/new content) is NOT recoverable 1:1 from
 * the decompiled corpus and is deliberately not re-invented; tracking stays
 * driven by direct calls into commitAttribution's track* functions.
 */
export {
  clearAttributionCaches,
  sweepFileContentCache,
} from './commitAttribution.js'

// Mirrors the official module state's `hooksRegistered: !1` field: hook
// registration must be idempotent so repeated startup paths (setup.ts's
// deferred registerAttributionHooks() call) cannot double-register.
let hooksRegistered = false

/** Test/introspection seam for the idempotence guard. */
export function isAttributionHooksRegistered(): boolean {
  return hooksRegistered
}

/**
 * Register attribution tracking hooks. Idempotent: only the first call has
 * any effect; subsequent calls are no-ops.
 */
export function registerAttributionHooks(): void {
  if (hooksRegistered) {
    return
  }
  hooksRegistered = true
}
