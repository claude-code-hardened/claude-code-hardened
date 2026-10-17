/**
 * Official max-concurrent-subagents gate — CCH port of the spawn gate in
 * docs/reverse-284/decompiled/0001-chunk-xrzcaagk/module-006-uncategorized.js
 * (do NOT redesign — the user's rule: mirror the official source):
 *
 *   var n8n=20;
 *   function f$n(){return a.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS??n8n}
 *   var o8n=()=>f$n();
 *   ...
 *   spawn: async (s,g) => {
 *     let {plugin:h}=g
 *     S = r.get(h) ?? 0
 *     w = n()                                   // live per-spawn limit read
 *     if (S >= w)
 *       throw `${h}: ${S} running at once; refused`
 *     r.set(h, S+1)
 *     let D = () => r.set(h, (r.get(h) ?? 1) - 1)
 *     try { return await e(...) } finally { D() }
 *   }
 *
 * Three official semantics, deliberately NOT "improved":
 * 1. REFUSE, not queue — at cap the spawn throws immediately and the tool
 *    surface hands the error back to the model. No waiting parents exist,
 *    so the agent-lifetime-slot deadlock (OMP issue #3749) cannot be
 *    constructed in this architecture at all.
 * 2. Per-agent-type counters — the map is keyed by the agent kind; the cap
 *    applies per kind, not as a global fleet total (o8n's default 20 is a
 *    per-kind ceiling).
 * 3. The limit is re-read at every spawn; release runs in finally.
 *
 * Scope split with subagentDepth.ts (4.1): the depth cap is VERTICAL (how
 * many layers below the main conversation), this gate is HORIZONTAL (how
 * many agents of a kind may run at once). Both live at runAgent.
 */

/** Official env var name (module-004-env-vars.js in the decompiled corpus). */
export const MAX_CONCURRENT_SUBAGENTS_ENV_VAR =
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS' as const

/** Official default (decompiled module-006: `var n8n=20`). */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20

/**
 * Parse the raw env value. >0 → cap; 0/negative → unlimited (undefined
 * signals "unlimited" to the getter); unset/non-numeric → undefined and the
 * getter falls back to the official default.
 */
export function parseMaxConcurrentSubagents(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isInteger(parsed) ? parsed : undefined
}

/**
 * Resolved cap: a positive count, or Infinity for "no limit". Unset or
 * non-numeric values fall back to the official default 20; an explicit
 * 0 or negative value means unlimited.
 */
export function getAgentConcurrencyLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = parseMaxConcurrentSubagents(
    env[MAX_CONCURRENT_SUBAGENTS_ENV_VAR],
  )
  if (parsed === undefined) return DEFAULT_MAX_CONCURRENT_SUBAGENTS
  return parsed > 0 ? parsed : Infinity
}

// ── per-kind running counters (official `r = new Map`) ─────────────────────

const runningByKind = new Map<string, number>()

export type AcquireAgentSlotOptions = {
  /** Agent kind the counters key on (official: the plugin/agent bucket). */
  agentKey?: string
  /** Env read (defaults to process.env; re-read at every spawn). */
  env?: Record<string, string | undefined>
}

/**
 * Official gate — synchronous check+increment, THROWING at cap (refuse,
 * never queue). Returns the release function for the finally.
 */
export function acquireAgentSlot(
  options: AcquireAgentSlotOptions = {},
): () => void {
  const key = options.agentKey ?? 'task'
  const limit = getAgentConcurrencyLimit(options.env)
  const running = runningByKind.get(key) ?? 0
  if (running >= limit) {
    throw new Error(
      `${key}: ${running} running at once; refused (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=${limit === Infinity ? 'unlimited-marker' : String(limit)})`,
    )
  }
  runningByKind.set(key, running + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = Math.max(0, (runningByKind.get(key) ?? 1) - 1)
    // Zero out and drop the key: agent types are attacker-influenceable
    // (arbitrary custom definitions) — leaving zeroed keys grows the Map
    // unboundedly across long-lived sessions.
    if (next === 0) {
      runningByKind.delete(key)
    } else {
      runningByKind.set(key, next)
    }
  }
}

/** Snapshot of the per-kind counters (diagnostics / tests). */
export function getAgentConcurrencyState(): {
  limit: number
  active: number
  keys: Record<string, number>
} {
  const keys: Record<string, number> = {}
  let active = 0
  for (const [k, v] of runningByKind) {
    keys[k] = v
    active += v
  }
  return { limit: getAgentConcurrencyLimit(), active, keys }
}

/** Test-only: drop all counters without waiting for agent teardown. */
export function resetAgentConcurrencyForTest(): void {
  runningByKind.clear()
}
