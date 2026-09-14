/**
 * compile 阶段的 A/B 开关解析（纯函数，零副作用）。
 *
 * CCB_COMPILE_BYTECODE 置 '1' 或 'true'（不区分大小写）时，
 * scripts/compile.ts 走 JSC bytecode 预编译路径（Bun 1.4+ 的
 * `bytecode: true` + `format: 'esm'`，支持顶层 await / 动态 import）；
 * 其余一切取值（未设置 / '0' / 'false' / 空串 / 垃圾串）走默认路径，
 * 与历史产物逐字节等价。
 */
export function resolveBytecodeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.CCB_COMPILE_BYTECODE
  if (typeof value !== 'string') return false
  const normalized = value.toLowerCase()
  return normalized === '1' || normalized === 'true'
}
