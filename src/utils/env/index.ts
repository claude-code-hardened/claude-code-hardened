/**
 * Env read face — resource basket (work package W7, task #58).
 *
 * Whitelisted home for scattered/experimental environment-variable reads so
 * feature areas stop minting raw `process.env.*` accessors. Consumers import
 * from `src/utils/env/index.js` or the specific modules below.
 */
export {
  getStageFileRoot,
  isAgentViewRelaunch,
  isArtifactAutoOpen,
  isEvalConfined,
  isSpawnedByServer,
  shouldPropagateNestedMemory,
} from './envReads.js'
export {
  isHookForwardingDisabled,
  isHookForwardingEnabled,
  isPluginForwardingDisabled,
  isPluginForwardingEnabled,
} from './forwardingGates.js'
export { AUTO_MODE_ENV_VAR, isAutoModeEnabled } from './autoModeEnv.js'
export {
  GRAY_ENV_GATE_NAMES,
  getEnabledGrayGates,
  grayGateEnvVar,
  isGrayGateEnabled,
  type GrayEnvGate,
} from './grayGates.js'
