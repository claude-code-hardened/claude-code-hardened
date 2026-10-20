import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

/**
 * Per-async-context cwd override holder. The override is boxed in a mutable
 * holder so a Cd executed inside an overridden context can UPDATE the
 * override in place (per-agent cwd changes stay scoped to that agent)
 * instead of leaking into the session-global cwd state. Prior behavior:
 * getCwd() respected the override but CdTool's setCwd() always wrote the
 * global — concurrent agents racing on cd overwrote each other's view.
 */
type CwdOverrideBox = { value: string }

const cwdOverrideStorage = new AsyncLocalStorage<CwdOverrideBox>()

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the global one. This enables concurrent
 * agents to each see their own working directory without affecting each other.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run({ value: cwd }, fn)
}

/**
 * True when the current async context carries a cwd override (per-agent
 * scope). CdTool uses this to decide which layer a chdir applies to.
 */
export function hasCwdOverride(): boolean {
  return cwdOverrideStorage.getStore() !== undefined
}

/**
 * Write the working directory for the CURRENT context: updates the per-agent
 * override when one is active (scoped, race-free across agents), otherwise
 * the caller falls back to the global session state write (setCwd in
 * utils/Shell.ts). Path normalization matches the global contract
 * (setCwdState applies NFC).
 * @returns true when the override layer was written; false when there is no
 * override and the caller must write the global layer itself.
 */
export function setCwdOverrideForCurrentContext(cwd: string): boolean {
  const box = cwdOverrideStorage.getStore()
  if (box === undefined) {
    return false
  }
  box.value = cwd.normalize('NFC')
  return true
}

/**
 * Get the current working directory
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore()?.value ?? getCwdState()
}

/**
 * Get the current working directory or the original working directory if the current one is not available
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
