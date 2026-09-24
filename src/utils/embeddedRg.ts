/**
 * Embedded ripgrep executable for bun --compile binaries.
 *
 * rg 是可执行程序而非共享库：写入内存后 execve 起独立进程。三级策略，
 * 按"尽可能不落盘"排序：
 *
 *   1. memfd_create（bun:ffi 调 libc）→ spawn('/dev/fd/<fd>')——内核
 *      匿名内存直接 exec，零文件对象。仅正常 Linux 可用；proot 会静默
 *      杀掉 memfd execve（exit=182、stderr 空，2026-09-24 实测），沙盒
 *      硬限制。
 *   2. /dev/shm tmpfs——文件物理介质是 RAM，磁盘零写入；proot 可用
 *      （同日实测 exit=0）。0700 + 进程退出清理。
 *   3. os.tmpdir() 兜底——部分设备（含本机）它本身也是 tmpfs。
 *
 * execvp 竞态注意：memfd 的 fd 不主动 close（spawn 返回与子进程路径
 * 解析存在竞态），MFD_CLOEXEC 保证 exec 成功后自动关闭，父进程持有至
 * 退出（单实例 ~5MB memfd）。
 */

import { EMBEDDED_RIPGREP } from './embeddedRg.gen'
import { logForDebugging } from './debug.js'

export type EmbeddedRg = { command: string }

let cached: EmbeddedRg | null | undefined

/** 编译产物里是否带了 rg（dev / 常规构建为 false）。 */
export function hasEmbeddedRg(): boolean {
  return typeof EMBEDDED_RIPGREP === 'string' && EMBEDDED_RIPGREP.length > 0
}

/**
 * 返回可直接 spawn 的 rg 命令；未嵌入或全部策略失败返回 null，调用方
 * 走 vendor/系统 rg 回退。结果模块级缓存——解码与内存准备只做一次。
 */
export function getEmbeddedRg(): EmbeddedRg | null {
  if (cached !== undefined) return cached
  cached = prepare()
  return cached
}

function prepare(): EmbeddedRg | null {
  if (!hasEmbeddedRg()) return null
  const buffer = Buffer.from(EMBEDDED_RIPGREP!, 'base64')
  try {
    if (process.platform === 'linux') {
      const memfd = memfdSpawnPath(buffer)
      if (memfd) return memfd
      logForDebugging(
        '[embedded-rg] memfd unavailable (container/proot?) → tmpfs fallback',
      )
    }
    return tmpfsSpawnPath(buffer)
  } catch (e) {
    logForDebugging(
      `[embedded-rg] prepare failed → vendor/system fallback: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

function memfdSpawnPath(buffer: Buffer): EmbeddedRg | null {
  const { dlopen: ffiDlopen } = require('bun:ffi') as typeof import('bun:ffi')
  const libc = ffiDlopen('libc.so.6', {
    memfd_create: { args: ['cstring', 'u32'], returns: 'i32' },
  })
  const fd = libc.symbols.memfd_create(
    'ccb-ripgrep',
    1 /* MFD_CLOEXEC */,
  ) as number
  if (!(fd > 2)) return null
  writeStaged(fd, buffer)
  // 可行性前移：fd 创建成功 ≠ execve 可行。proot 会静默杀 memfd execve
  // （exit=182、stderr 空，2026-09-24 实测）——spawn 返回后才炸就晚了。
  // 先试探一次，失败即降级 tmpfs，绝不返回坏命令。
  if (!probeSpawnable(`/dev/fd/${fd}`)) {
    const { closeSync } = require('node:fs') as typeof import('node:fs')
    try {
      closeSync(fd)
    } catch {
      /* already gone */
    }
    return null
  }
  return { command: `/dev/fd/${fd}` }
}

/** 一次性 spawn 试探：status===0 即可执行（--version 成本 ~30ms，仅一次）。 */
function probeSpawnable(command: string): boolean {
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function writeStaged(fd: number, buffer: Buffer): void {
  const { ftruncateSync, writeSync } =
    require('node:fs') as typeof import('node:fs')
  ftruncateSync(fd, buffer.length) // memfd 初始 size=0，execve 前需定长
  writeSync(fd, buffer)
}

// ── tmpfs / tmpdir 落盘路径（0700 + 退出清理） ────────────────────────────

const tmpCleanups: Array<() => void> = []
let cleanupRegistered = false

function tmpfsSpawnPath(buffer: Buffer): EmbeddedRg | null {
  const fs = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg'
  // /dev/shm 优先（tmpfs，RAM 介质）；不可用落 tmpdir（多数设备同为 tmpfs）
  const bases =
    process.platform !== 'win32' ? ['/dev/shm', tmpdir()] : [tmpdir()]
  for (const base of bases) {
    let dir: string
    try {
      dir = fs.mkdtempSync(join(base, 'ccb-rg-'))
    } catch {
      continue
    }
    const bin = join(dir, name)
    fs.writeFileSync(bin, buffer)
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o700)
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
