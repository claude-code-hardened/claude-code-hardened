/**
 * Experimental gray-gate group (work package W7, task #58 block 7).
 *
 * Official anchor: 0043-chunk-zrkp23rq/module-003-env-vars.js enumerates the
 * two-word codename env switches side by side (BASALT_COVE..BREEZY_HORIZON);
 * THRIFTY_SONIC additionally shows up in 0082-chunk-dxsxk16b/config/env-vars.js.
 * These ship default-OFF in the official build — routes are flipped per env
 * via CLAUDE_CODE_<NAME>=1 during staged rollouts.
 *
 * Registered on the repo's feature-gate/defines face (scripts/defines.ts) as
 * a documented group; the runtime read face lives here so gates stay env-
 * driven (no rebuild required) instead of baking into DEFAULT_BUILD_FEATURES.
 */

import { isEnvTruthy } from '../envUtils.js'

/**
 * The ten official gray gates, in the Chunk-0043 enumeration order.
 * `Simple`/`SimpleSystemPrompt` from the same list are excluded: they are
 * plain boolean knobs (--bare / system-prompt swaps), not staged rollouts.
 */
export const GRAY_ENV_GATE_NAMES = [
  'BASALT_COVE',
  'THRIFTY_SONIC',
  'COZY_TEAPOT',
  'GORSE_PLOVER',
  'AMBER_ASTROLABE',
  'BISON_CAIRN',
  'LARCH_CISTERN',
  'WILLOW_TERN',
  'PARCHMENT_FERN',
  'BREEZY_HORIZON',
] as const

export type GrayEnvGate = (typeof GRAY_ENV_GATE_NAMES)[number]

/** Env var backing a gray gate: CLAUDE_CODE_BASALT_COVE and friends. */
export function grayGateEnvVar(gate: GrayEnvGate): string {
  return `CLAUDE_CODE_${gate}`
}

/**
 * Gray gates default OFF. Only an explicit truthy value (1/true/yes/on)
 * enables a route; unset or explicitly falsy values stay disabled.
 */
export function isGrayGateEnabled(gate: GrayEnvGate): boolean {
  return isEnvTruthy(process.env[grayGateEnvVar(gate)])
}

/** Snapshot of every currently-enabled gray gate (in enumeration order). */
export function getEnabledGrayGates(): GrayEnvGate[] {
  return GRAY_ENV_GATE_NAMES.filter(gate => isGrayGateEnabled(gate))
}
