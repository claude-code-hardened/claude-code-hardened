#!/usr/bin/env bun
/**
 * 产物启动性能靶点：测量单文件 compile binary 的快速路径耗时。
 *
 * 指标（ms，多次运行取 min/median/max）：
 *   - --version        纯解析+启动路径（bytecode 收益最敏感的靶点）
 *   - --check-commands 全量 shim 加载（bundle 完整性 + 求值开销靶点）
 *
 * 参考基线（本机 aarch64 Linux，bun 1.4.2，2026-09-14 三次取中位）：
 *   - 非 bytecode：--version 1160ms / --check-commands 1486ms（minify 后 111MB）
 *   - bytecode：   --version  199ms / --check-commands 1280ms（171MB，+53%）
 * 靶点回归判定：bytecode 产物 --version 中位显著高于 500ms 即异常。
 *
 * 零 npm 依赖。产物 binary 由 CI package job 产出（gh run download），
 * 本机仅执行该 binary——符合"本机禁构建、产物可实测"约定。
 *
 * 用法：bun scripts/bench-startup.ts <binary路径> [--runs 3]
 */
import { basename } from 'node:path'
import { existsSync } from 'node:fs'

const BASELINE = {
  'non-bytecode': { version: 1160, checkCommands: 1486 },
  bytecode: { version: 199, checkCommands: 1280 },
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function timeOnce(binary: string, args: string[]): Promise<number> {
  const start = performance.now()
  const proc = Bun.spawn([binary, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const code = await proc.exited
  const elapsed = performance.now() - start
  if (code !== 0) {
    throw new Error(`${binary} ${args.join(' ')} exited with code ${code}`)
  }
  return Math.round(elapsed)
}

async function probe(
  binary: string,
  args: string[],
  runs: number,
): Promise<{ min: number; median: number; max: number }> {
  // 首跑预热（页缓存/首次映射），不计入统计
  await timeOnce(binary, args)
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    samples.push(await timeOnce(binary, args))
  }
  return {
    min: Math.min(...samples),
    median: median(samples),
    max: Math.max(...samples),
  }
}

const binaryArg = process.argv[2]
const runsFlag = process.argv.indexOf('--runs')
// 校验为正整数：负数/0/小数/NaN 一律回退 3（空 samples 会让 median=NaN，
// NaN > 阈值恒为 false，曾造成非法输入假 PASS）
const parsedRuns = runsFlag > -1 ? Number(process.argv[runsFlag + 1]) : 3
const runs = Number.isInteger(parsedRuns) && parsedRuns > 0 ? parsedRuns : 3

if (!binaryArg || !existsSync(binaryArg)) {
  console.error('用法: bun scripts/bench-startup.ts <binary路径> [--runs 3]')
  console.error('  binary 应为 CI package job 产物（dist/ccb-<host平台>）')
  process.exit(1)
}
const binary = binaryArg

// timeOnce 计的是父进程 spawn→exited 墙钟（含 fork/exec 数十 ms 开销），
// x64 host 普遍慢于本基线所在的 aarch64——阈值按架构归一。
const REGRESSION_MS = process.arch === 'arm64' ? 500 : 800

console.log(
  `target: ${basename(binary)} (arch=${process.arch}, runs=${runs} + 1 warmup)`,
)
let version, check
try {
  version = await probe(binary, ['--version'], runs)
  check = await probe(binary, ['--check-commands'], runs)
} catch (err) {
  console.error(`✗ probe failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

console.log('\n┌─ startup perf probes (ms) ─────────────────────')
console.log(
  `│ --version        min=${version.min} median=${version.median} max=${version.max}`,
)
console.log(
  `│ --check-commands min=${check.min} median=${check.median} max=${check.max}`,
)
console.log('└────────────────────────────────────────────────')

console.log('\nreference baseline (aarch64, bun 1.4.2, 2026-09-14):')
console.log(
  `  bytecode:   --version ${BASELINE.bytecode.version}ms / --check-commands ${BASELINE.bytecode.checkCommands}ms`,
)
console.log(
  `  non-bytecode: --version ${BASELINE['non-bytecode'].version}ms / --check-commands ${BASELINE['non-bytecode'].checkCommands}ms`,
)

if (version.median > REGRESSION_MS) {
  console.error(
    `\n✗ --version median ${version.median}ms 超过 bytecode 回归阈值 ${REGRESSION_MS}ms——产物可能未启用 bytecode 预编译或启动路径回归`,
  )
  process.exit(2)
}
console.log(
  `\n✓ --version median ${version.median}ms ≤ ${REGRESSION_MS}ms（bytecode 生效）`,
)
