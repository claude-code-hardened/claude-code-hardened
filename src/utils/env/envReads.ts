/**
 * Scattered env-var read face (work package W7, task #58 block 8).
 *
 * Official anchors (docs/reverse-284/decompiled, env-vars chunks — grep-name
 * evidence):
 *   - CLAUDE_CODE_SPAWNED_BY_SERVER  — 0044-chunk-zrkp23rq/module-002-env-vars.js
 *   - CLAUDE_STAGE_FILE_ROOT         — 0004-chunk-zrkp23rq/module-003-env-vars.js
 *     (note: not CLAUDE_CODE_ prefixed in the official build)
 *   - CLAUDE_CODE_EVAL_CONFINED     — 0001-chunk-xrzcaagk/module-004-env-vars.js
 *     (official: "confined evaluation run" — subagent permission-mode note in
 *     0039-chunk-zrkp23rq/permissions/checker.js)
 *   - CLAUDE_CODE_AGENT_VIEW_RELAUNCH — 0044-chunk-zrkp23rq/module-002-env-vars.js
 *   - CLAUDE_CODE_ARTIFACT_AUTO_OPEN  — 0047-chunk-dxsxk16b/module-001-env-vars.js
 *
 * All reads funnel through envUtils' isEnvTruthy so '0'/'false'/'no'/'off'
 * count as explicitly off, matching the rest of the codebase.
 */

import { isEnvTruthy } from '../envUtils.js'

/** Set by the RCS/server supervisor when this process is a spawned session child. */
export function isSpawnedByServer(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SPAWNED_BY_SERVER)
}

/**
 * Root directory for stage files (staged prompts/uploads). Official build
 * uses the non-CODE-prefixed name CLAUDE_STAGE_FILE_ROOT.
 */
export function getStageFileRoot(): string | undefined {
  const root = process.env.CLAUDE_STAGE_FILE_ROOT
  return root && root.trim() !== '' ? root : undefined
}

/**
 * True inside a confined evaluation run: subagent-declared permission modes
 * (bypassPermissions/acceptEdits/auto) are pinned to the parent mode.
 */
export function isEvalConfined(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_EVAL_CONFINED)
}

/** Set when the CLI was relaunched into the agent view (web relaunch flow). */
export function isAgentViewRelaunch(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_AGENT_VIEW_RELAUNCH)
}

/** Skip the open-prDescription confirm and auto-open the HTML artifact. */
export function isArtifactAutoOpen(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN)
}

/**
 * Propagate nested-memory (CLAUDE.md) load triggers from a subagent back to
 * the parent context. Official decompiled name is the long COORDINATOR form
 * (0039-chunk-zrkp23rq/module-006-env-vars.js + propagateNestedMemory cleanup
 * stage in 0039-chunk.../permissions/checker.js); the short
 * CLAUDE_CODE_PROPAGATE_NESTED_MEMORY spelling seen in work specs abbreviates
 * the same knob.
 */
export function shouldPropagateNestedMemory(): boolean {
  return isEnvTruthy(
    process.env.CLAUDE_CODE_COORDINATOR_PROPAGATE_NESTED_MEMORY,
  )
}
