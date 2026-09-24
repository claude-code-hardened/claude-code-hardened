import { hasEmbeddedSearchToolPayloads } from './embeddedSearchTools.js'

/**
 * Whether this build has bfs/ugrep embedded (compile 产物注入 payload).
 *
 * When true:
 * - `find` and `grep` in Claude's Bash shell are shadowed by shell functions
 *   that invoke the binary with argv0='bfs' / argv0='ugrep'（cli.tsx 的
 *   argv0 分发器在启动时 stage 内嵌二进制并透传执行）
 * - The dedicated Glob/Grep tools are removed from the tool registry
 * - Prompt guidance steering Claude away from find/grep is omitted
 *
 * 判定是运行时的（嵌入 payload 非空），不再读 EMBEDDED_SEARCH_TOOLS 环境变量——
 * 该变量全仓库无设置点（死锁），ant-native 注释已过时。SDK 入口仍排除：
 * SDK 宿主可能有独立的 find/grep 语义。
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!hasEmbeddedSearchToolPayloads()) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * Path to the binary that dispatches embedded search tools via argv0.
 * Only meaningful when hasEmbeddedSearchTools() is true.
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
