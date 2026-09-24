/**
 * bfs/ugrep 嵌入态（staging 走通用 embeddedStage.ts：memfd → /dev/shm →
 * tmpdir 三级策略 + noexec 探测，与已验证的 embeddedRg.ts 同构逻辑）。
 *
 * 数据源：src/utils/embeddedSearch.gen.ts（compile.ts plugin 注入）。
 * 消费方：cli.tsx 的 argv0 分发器（embeddedDispatch.ts）与
 * embeddedTools.ts 的运行时开关判定。
 */

import { EMBEDDED_SEARCH_TOOLS } from './embeddedSearch.gen'
import { stageExecutable } from './embeddedStage.js'
import type { StagedExecutable } from './embeddedStage.js'

export type SearchToolName = 'bfs' | 'ugrep'

/** 产物里是否带了任一搜索工具（dev / 常规构建为 false）。 */
export function hasEmbeddedSearchToolPayloads(): boolean {
  return (
    (typeof EMBEDDED_SEARCH_TOOLS.bfs === 'string' &&
      EMBEDDED_SEARCH_TOOLS.bfs.length > 0) ||
    (typeof EMBEDDED_SEARCH_TOOLS.ugrep === 'string' &&
      EMBEDDED_SEARCH_TOOLS.ugrep.length > 0)
  )
}

/** 工具级判定：bfs 是否在本 build 里（Windows 构建为 false——上游无官方支持）。 */
export function hasEmbeddedBfsPayload(): boolean {
  return (
    typeof EMBEDDED_SEARCH_TOOLS.bfs === 'string' &&
    EMBEDDED_SEARCH_TOOLS.bfs.length > 0
  )
}

/** 工具级判定：ugrep 是否在本 build 里。 */
export function hasEmbeddedUgrepPayload(): boolean {
  return (
    typeof EMBEDDED_SEARCH_TOOLS.ugrep === 'string' &&
    EMBEDDED_SEARCH_TOOLS.ugrep.length > 0
  )
}

/**
 * 返回可直接 spawn 的工具命令；未嵌入或全部策略失败返回 null，调用方
 * 走 PATH 回退。结果按工具名缓存（stagedCache 在 embeddedStage 内）。
 */
export function getEmbeddedSearchTool(
  name: SearchToolName,
): StagedExecutable | null {
  const base64 = EMBEDDED_SEARCH_TOOLS[name]
  if (typeof base64 !== 'string' || base64.length === 0) return null
  const binaryName = process.platform === 'win32' ? `${name}.exe` : name
  return stageExecutable(`search-${name}`, base64, binaryName)
}
