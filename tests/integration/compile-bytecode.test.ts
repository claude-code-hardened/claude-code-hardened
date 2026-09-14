import { readFileSync } from 'node:fs'

describe('compile bytecode configuration guard', () => {
  const compileSource = readFileSync('scripts/compile.ts', 'utf8')

  test('single-file compile enables JSC bytecode precompilation by default', () => {
    // bytecode + format: 'esm' 是 Bun 1.4+ 的组合（支持顶层 await 与动态
    // import）。2026-09-14 A/B 实测 --version 1.16s→0.20s 后定为默认行为；
    // 若移除则产物退回纯解析路径，此守卫防止无意识回归。
    expect(compileSource).toContain('bytecode: true')
    expect(compileSource).toContain("format: 'esm'")
  })

  test('bytecode is applied per-target inside the singular compile loop', () => {
    // SIGILL 教训：复数 targets 被 Bun 静默忽略、产物退化为 host 架构。
    // bytecode 键必须在 Bun.build 顶层（compile 段保持单数 target）。
    const buildCall = compileSource.slice(
      compileSource.indexOf('await Bun.build'),
      compileSource.indexOf('compile: {'),
    )
    expect(buildCall).toContain('bytecode: true')
    expect(buildCall).toContain("format: 'esm'")
    expect(compileSource).not.toContain('targets:')
  })

  test('compileFlags env switch module was removed', () => {
    // 开关已被"默认启用"决策取代；若有人重新引入 CCB_COMPILE_BYTECODE
    // 分支逻辑，应同时更新本守卫与 docs，而不是悄悄复活双路径。
    expect(compileSource).not.toContain('CCB_COMPILE_BYTECODE')
    expect(compileSource).not.toContain('compileFlags')
  })
})
