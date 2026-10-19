/**
 * W4 (#55) — per-call sandbox network list merging.
 *
 * Official semantics: BashTool accepts sandboxNetworkLists({allow, deny}) as a
 * tool input and the lists are merged into the network restriction config used
 * for that command's sandbox. This helper is the pure merge point for the
 * SandboxManager.wrapWithSandbox customConfig.network argument.
 */

import type { SandboxRuntimeConfig } from './sandbox-adapter.js'

/** Tool-input shape: host patterns to allow/deny for one command. */
export type SandboxNetworkLists = {
  allow?: string[]
  deny?: string[]
}

/**
 * Status-view shape returned by SandboxManager.getNetworkRestrictionConfig()
 * (the sandbox-runtime NetworkRestrictionConfig): the session network policy
 * with allowedHosts/deniedHosts keys. customConfig.network expects the
 * SandboxRuntimeConfig shape (allowedDomains/deniedDomains) instead — the
 * builder below bridges the two.
 */
export type NetworkRestrictionView = {
  allowedHosts?: string[]
  deniedHosts?: string[]
}

type NetworkConfig = SandboxRuntimeConfig['network']

/**
 * Merge per-call lists into a (possibly partial) network config. Order- and
 * case-preserving, deduplicated; base entries keep priority in the list order.
 * Enforcement-layer precedence (deny over allow, policy caps beyond both) is
 * owned by sandbox-runtime, not by this merge.
 */
export function mergeNetworkLists(
  base: Partial<NetworkConfig> | undefined,
  lists: SandboxNetworkLists | undefined,
): NetworkConfig {
  const allowedDomains = [...(base?.allowedDomains ?? [])]
  const deniedDomains = [...(base?.deniedDomains ?? [])]

  const appendUnique = (target: string[], values: string[] | undefined) => {
    for (const value of values ?? []) {
      if (!target.includes(value)) {
        target.push(value)
      }
    }
  }
  appendUnique(allowedDomains, lists?.allow)
  appendUnique(deniedDomains, lists?.deny)

  return {
    ...base,
    allowedDomains,
    deniedDomains,
  }
}

/**
 * Build the per-call customConfig.network for SandboxManager.wrapWithSandbox:
 * the session restriction config (status view) merged with the per-call
 * { allow, deny } lists. Returns undefined when there is nothing per-call to
 * apply, so callers keep passing customConfig=undefined — byte-identical to
 * the pre-W4 call shape.
 */
export function buildCustomNetworkConfig(
  baseView: NetworkRestrictionView | undefined,
  lists: SandboxNetworkLists | undefined,
): NetworkConfig | undefined {
  const hasAllow = lists?.allow !== undefined && lists.allow.length > 0
  const hasDeny = lists?.deny !== undefined && lists.deny.length > 0
  if (!hasAllow && !hasDeny) {
    return undefined
  }
  return mergeNetworkLists(
    {
      allowedDomains: [...(baseView?.allowedHosts ?? [])],
      deniedDomains: [...(baseView?.deniedHosts ?? [])],
    },
    lists,
  )
}
