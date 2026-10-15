/**
 * Subagent spawn-depth cap — CCH port of the official `subagent_depth_cap`
 * semantics (docs/reverse-284/decompiled/0128-chunk-zrkp23rq/tools/agent.js):
 *
 *   let Tt=xd(e.agentContext),kt=xv();
 *   if(Tt>=kt) throw ... "Subagent nesting limit reached (depth ${Tt} of ${kt})"
 *   ... let me=xd(e.agentContext)+1;  // child depth recorded in telemetry
 *
 * i.e. the SPAWNER's current depth is compared against the configured max;
 * a spawner at max depth may not spawn another agent. The parent chain here
 * is the per-agent spawn registry filled by runAgent (official uses the
 * agentContext chain; CCH has no equivalent, so we track it ourselves).
 *
 * Depth semantics: main conversation = 0. Each spawned subagent = parent+1.
 * Teammate spawns (`team_name` && `name`) go through the same check at the
 * single entry point in AgentTool.call, so they count toward the same depth.
 *
 * This module is intentionally PURE (no I/O, no logger imports) so the
 * depth-calculation, default-value and rejection logic can be unit tested
 * without mocking the analytics/debug chains.
 */

/** Official env var name (module-004-env-vars.js in the decompiled corpus). */
export const MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR =
  'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH' as const

/**
 * Official default: 3 subagent layers below the main conversation.
 *
 * The numeric default is NOT extractable from the decompiled corpus (the
 * env-var reader `xv()` lives in chunks outside docs/reverse-284), so this
 * uses the value documented in the official env-var reference
 * (code.claude.com/docs/en/env-vars): "Number of subagent layers allowed
 * below the main conversation (default: 3)" — default 3 since v2.1.219.
 */
export const DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 3

/**
 * Parse the raw env value. Official contract: "Accepts a positive whole
 * number in plain digits; anything else is ignored" — so `0`, negatives,
 * non-numeric and empty values all fall back to the default.
 */
export function parseMaxSubagentSpawnDepth(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

/** Read the configured cap. Missing/invalid env values fall back to the official default. */
export function getMaxSubagentSpawnDepth(
  env: Record<string, string | undefined> = process.env,
): number {
  return (
    parseMaxSubagentSpawnDepth(env[MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR]) ??
    DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH
  )
}

// ── per-agent spawn-depth registry ─────────────────────────────────────────
// Officially this lives on the agentContext chain (xd(e.agentContext)). CCH
// has no such chain, so runAgent registers every spawned agent's depth right
// after its agentId is created and unregisters in its finally block. Nested
// spawns then resolve their spawner's depth from toolUseContext.agentId.

const spawnDepthByAgentId = new Map<string, number>()

export function registerSubagentSpawnDepth(
  agentId: string,
  spawnDepth: number,
): void {
  spawnDepthByAgentId.set(agentId, spawnDepth)
}

export function unregisterSubagentSpawnDepth(agentId: string): void {
  spawnDepthByAgentId.delete(agentId)
}

export function getRegisteredSubagentSpawnDepth(
  agentId: string,
): number | undefined {
  return spawnDepthByAgentId.get(agentId)
}

/** Test-only: drop every registration without waiting for agent teardown. */
export function clearSubagentSpawnDepthsForTest(): void {
  spawnDepthByAgentId.clear()
}

/**
 * Depth of the agent that is about to spawn a child.
 *
 * - undefined agentId → 0: the main conversation.
 * - registered agentId → its spawn depth.
 * - defined but unregistered agentId → 1 (conservative): in-process teammates
 *   (spawned via spawnTeammate, outside this registry) and resumed agents.
 *   Treating unknown subagent contexts as depth 1 keeps the cap meaningful
 *   for those chains without over-blocking the common main-thread spawn.
 */
export function getSubagentSpawnDepth(agentId: string | undefined): number {
  if (agentId === undefined) return 0
  return spawnDepthByAgentId.get(agentId) ?? 1
}

/** Official comparison: the spawner is blocked when its depth >= max. */
export function isSubagentSpawnDepthAtCap(
  currentDepth: number,
  maxDepth: number,
): boolean {
  return currentDepth >= maxDepth
}

export type SubagentSpawnDepthEvaluation = {
  /** Depth of the requesting agent (0 = main conversation). */
  currentDepth: number
  /** Configured cap (env override or official default 3). */
  maxDepth: number
  /** Depth the child would occupy (currentDepth + 1). Telemetry value. */
  nextDepth: number
  /** False when the spawn must be refused. */
  allowed: boolean
}

/**
 * Evaluate a spawn request against the cap. Called once at the single spawn
 * entry point (AgentTool.call) — covers regular subagents, fork spawns and
 * teammate spawns (`team_name` && `name`), matching the official placement
 * at the top of the agent tool before any other spawn work.
 */
export function evaluateSubagentSpawnDepth({
  agentId,
  env = process.env,
}: {
  agentId: string | undefined
  env?: Record<string, string | undefined>
}): SubagentSpawnDepthEvaluation {
  const currentDepth = getSubagentSpawnDepth(agentId)
  const maxDepth = getMaxSubagentSpawnDepth(env)
  return {
    currentDepth,
    maxDepth,
    nextDepth: currentDepth + 1,
    allowed: !isSubagentSpawnDepthAtCap(currentDepth, maxDepth),
  }
}

/**
 * Structured rejection error, message text aligned with the official copy:
 * "Subagent nesting limit reached (depth N of M). Complete this task
 * directly using your tools instead of spawning another agent. If the user
 * explicitly requested deeper nesting, ask them to raise
 * CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH."
 */
export function subagentDepthCapError(
  currentDepth: number,
  maxDepth: number,
): Error {
  return new Error(
    `Subagent nesting limit reached (depth ${currentDepth} of ${maxDepth}). ` +
      'Complete this task directly using your tools instead of spawning another agent. ' +
      `If the user explicitly requested deeper nesting, ask them to raise ${MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR}.`,
  )
}
