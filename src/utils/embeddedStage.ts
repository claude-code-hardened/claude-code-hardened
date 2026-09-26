/**
 * 通用内嵌可执行文件 staging（rg / bfs / ugrep 共用）。
 *
 * base64 → 内存准备 → 可 spawn 路径。三级策略按"尽可能不落盘"排序：
 *
 *   1. memfd_create（bun:ffi 调 libc）→ spawn('/dev/fd/<fd>')——内核
 *      匿名内存直接 exec，零文件对象。仅正常 Linux 可用；proot 会静默
 *      杀 memfd execve（exit=182、stderr 空，2026-09-24 实测），沙盒
 *      硬限制。
 *   2. /dev/shm tmpfs——文件物理介质是 RAM，磁盘零写入；proot 可用
 *      （同日实测 exit=0）。0700 + 进程退出清理；noexec 挂载自动探测
 *      换路（OCR P2）。
 *   3. os.tmpdir() 兜底——部分设备（含本机）它本身也是 tmpfs。
 *
 * 全同步 API（spawnSync probe）——getRipgrepConfig 等消费方是同步链，
 * 不允许 async 传染。
 */

import { logForDebugging } from './debug.js'

export type StagedExecutable = { command: string }

const stagedCache = new Map<string, StagedExecutable | null>()

const tmpCleanups: Array<() => void> = []
let cleanupRegistered = false

/**
 * stage 一个内嵌可执行文件（结果按 id 模块级缓存，重复调用零开销）。
 * 全部策略失败返回 null，调用方走 vendor/系统回退。
 */
export function stageExecutable(
  id: string,
  base64: string,
  binaryName: string,
): StagedExecutable | null {
  const cached = stagedCache.get(id)
  if (cached !== undefined) return cached
  const staged = prepare(id, base64, binaryName)
  stagedCache.set(id, staged)
  return staged
}

/** 查询已 stage 的工具（不触发准备）。 */
export function getStaged(id: string): StagedExecutable | null {
  return stagedCache.get(id) ?? null
}

function prepare(
  id: string,
  base64: string,
  binaryName: string,
): StagedExecutable | null {
  if (!base64) return null
  const buffer = Buffer.from(base64, 'base64')
  try {
    if (process.platform === 'linux') {
      const memfd = memfdSpawnPath(id, buffer)
      if (memfd) return memfd
      logForDebugging(
        `[embedded-stage] ${id}: memfd unavailable (container/proot?) → tmpfs fallback`,
      )
    }
    return tmpfsSpawnPath(id, buffer, binaryName)
  } catch (e) {
    logForDebugging(
      `[embedded-stage] ${id}: prepare failed → vendor/system fallback: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

function memfdSpawnPath(id: string, buffer: Buffer): StagedExecutable | null {
  const { dlopen: ffiDlopen } = require('bun:ffi') as typeof import('bun:ffi')
  const libc = ffiDlopen('libc.so.6', {
    memfd_create: { args: ['cstring', 'u32'], returns: 'i32' },
  })
  const fd = libc.symbols.memfd_create(
    `cch-${id}`,
    1 /* MFD_CLOEXEC */,
  ) as number
  if (!(fd > 2)) return null
  const { ftruncateSync, writeSync } =
    require('node:fs') as typeof import('node:fs')
  ftruncateSync(fd, buffer.length) // memfd 初始 size=0，execve 前需定长
  writeSync(fd, buffer)
  // 可行性前移：fd 创建成功 ≠ execve 可行。proot 会静默杀 memfd execve
  // （exit=182、stderr 空，2026-09-24 实测）——spawn 返回后才炸就晚了。
  // 先试探一次，失败即降级 tmpfs，绝不返回坏命令。
  const command = `/dev/fd/${fd}`
  if (!probeSpawnable(command)) {
    const { closeSync } = require('node:fs') as typeof import('node:fs')
    try {
      closeSync(fd)
    } catch {
      /* already gone */
    }
    return null
  }
  logForDebugging(`[embedded-stage] ${id}: staged via memfd → ${command}`)
  return { command }
}

/** 一次性 spawn 试探：status===0 即可执行（--version 成本 ~30ms，仅一次）。 */
export function probeSpawnable(command: string): boolean {
  try {
    const { spawnSync } =
      require('node:child_process') as typeof import('node:child_process')
    return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

// ── tmpfs / tmpdir 落盘路径（0700 + 退出清理） ────────────────────────────

function tmpfsSpawnPath(
  id: string,
  buffer: Buffer,
  binaryName: string,
): StagedExecutable | null {
  const fs = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  // /dev/shm 优先（tmpfs，RAM 介质）；不可用落 tmpdir（多数设备同为 tmpfs）
  const bases =
    process.platform !== 'win32' ? ['/dev/shm', tmpdir()] : [tmpdir()]
  for (const base of bases) {
    let dir: string
    try {
      dir = fs.mkdtempSync(join(base, `cch-${id}-`))
    } catch {
      continue
    }
    const bin = join(dir, binaryName)
    fs.writeFileSync(bin, buffer)
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o700)
    // noexec 挂载探测（OCR P2）：/dev/shm 或 tmpdir 可能 noexec——
    // mkdtemp/write/chmod 都会成功但 exec 报 EACCES。落盘后先试跑
    // --version，失败清目录换下一个 base。
    if (!probeSpawnable(bin)) {
      logForDebugging(
        `[embedded-stage] ${id}: ${base} not executable (noexec?) → next base`,
      )
      fs.rmSync(dir, { recursive: true, force: true })
      continue
    }
    logForDebugging(`[embedded-stage] ${id}: staged via tmpfs → ${bin}`)
    if (!cleanupRegistered) {
      cleanupRegistered = true
      process.on('exit', () => {
        for (const fn of tmpCleanups) {
          try {
            fn()
          } catch {
            /* exit path — best effort */
          }
        }
      })
    }
    tmpCleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    return { command: bin }
  }
  return null
}
