/**
 * Auto-mode env gate (work package W7, task #58 block 6).
 *
 * Official anchor: CLAUDE_CODE_ENABLE_AUTO_MODE is listed among the boolean
 * env switches in 0011-chunk-bxerm1mk/module-003-env-vars.js and
 * 0044-chunk-zrkp23rq/module-002-env-vars.js ("ENABLE_" = opt-in, default
 * off).
 *
 * Unification face: the existing auto-mode surface keys off
 * permissionSetup.isAutoModeGateEnabled (settings/circuit-breaker/model
 * checks). That file sits outside this work package's file whitelist, so its
 * adoption of this gate is deferred; until then this module is the single
 * CLAUDE_CODE_ENABLE_AUTO_MODE read face, and whitelisted surfaces (bridge/
 * hooks) consult it instead of sprinkling raw process.env reads.
 */

import { isEnvTruthy } from '../envUtils.js'

export const AUTO_MODE_ENV_VAR = 'CLAUDE_CODE_ENABLE_AUTO_MODE'

/**
 * True only when the operator explicitly opted in ('1'/'true'/'yes'/'on').
 * Default: off — '0'/'false' and unset all resolve to disabled.
 */
export function isAutoModeEnabled(): boolean {
  return isEnvTruthy(process.env[AUTO_MODE_ENV_VAR])
}
