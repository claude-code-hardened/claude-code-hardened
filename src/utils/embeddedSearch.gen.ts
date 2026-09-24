/**
 * 内嵌搜索工具（构建时由 scripts/compile.ts 的 Bun plugin 覆盖注入）。
 *
 * 仓库中的这份是空模板：dev / 常规构建下 EMBEDDED_SEARCH_TOOLS 全 null，
 * hasEmbeddedSearchTools() 返回 false，shell 集成不注入。编译单文件二进制
 * 时，plugin 用目标平台 bfs/ugrep 二进制的 base64 内容替换本模块。
 *
 * 加载方式与 rg 相同：memfd/execve（见 src/utils/embeddedDispatch.ts），
 * 由 cli.tsx 的 argv0 分发器消费。
 */
export const EMBEDDED_SEARCH_TOOLS: {
  bfs: string | null
  ugrep: string | null
} = { bfs: null, ugrep: null }
