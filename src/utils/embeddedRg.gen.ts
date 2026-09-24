/**
 * 内嵌 ripgrep（构建时由 scripts/compile.ts 的 Bun plugin 覆盖注入）。
 *
 * 仓库中的这份是空模板：dev / 常规构建下 getEmbeddedRg 返回 null，
 * ripgrep.ts 走 vendor/ 或系统 rg 回退。编译单文件二进制时，plugin 在
 * 打包阶段用目标平台 rg 二进制的 base64 内容替换本模块。
 *
 * rg 是可执行程序（非共享库），加载方式为 memfd + execve（见
 * src/utils/embeddedRg.ts），而非 .node 模块的 dlopen。
 */
export const EMBEDDED_RIPGREP: string | null = null
