/**
 * 内嵌原生模块表（构建时由 scripts/compile.ts 的 Bun plugin 覆盖注入）。
 *
 * 仓库中的这份是空模板：dev / 常规构建下 loadNativeModule 直接走 vendor/ 回退。
 * 编译单文件二进制时，plugin 在打包阶段用目标平台的 base64 内容替换本模块，
 * 运行时通过 process.dlopen(mod, buffer) 从内存直接加载，不落盘。
 *
 * key   = 模块名（token-counter / transcript-parser / color-diff）
 * value = .node 文件内容的 base64
 */
export const EMBEDDED_NATIVES: Record<string, string> = {}
