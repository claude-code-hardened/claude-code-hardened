/**
 * Pure-FFI file scanner over the file-index native library
 * (packages/file-index-napi, exported as `ccb_scan_files_into`).
 *
 * 与 embeddedNative.ts 的 napi 通道互补：这里不走 napi 注册表，而是用
 * bun:ffi 直接声明 extern "C" 符号，并把调用放到 Bun 线程池
 * （符号声明 `async: true` → 返回 Promise，事件循环不阻塞）。
 *
 * 加载路径（对齐 embeddedNative.ts 的内嵌策略）：
 *   - 编译二进制（isCompiledBinary()）：EMBEDDED_NATIVES['file-index']
 *     base64 → Buffer → memfd_create（bun:ffi 直调 libc）→ ftruncate →
 *     writeSync → process.dlopen(`/dev/fd/${fd}`)。Bun 1.4.2 实测：
 *     /proc/self/fd 与 Buffer 形式的 dlopen 均失效，`/dev/fd/${fd}` 是
 *     唯一可用路径。
 *   - dev / 非编译：cargo 产物真实路径
 *     packages/file-index-napi/native/target/<triple>/release/
 *     libfile_index_napi.so（存在才用）直接 bun:ffi dlopen。
 *
 * 符号协议（换行分隔 = `rg --files` 行语义，无需 JSON）：
 *   ccb_scan_files_into(root, excludes, buf, buf_len) -> isize
 *   - 成功：`\n` 分隔的绝对路径写入 buf，返回内容字节数（不含结尾 \0）
 *   - buf_len 不足：返回 -(所需字节数)，JS 按绝对值扩容重试一次
 *   - 其他错误：-1（excludes 为 \n 分隔的目录名串）
 */

import { dlopen } from 'bun:ffi'
import { existsSync, ftruncateSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompiledBinary } from './embeddedNative.js'
import { EMBEDDED_NATIVES } from './embeddedNatives.gen'

/**
 * bun:ffi 符号声明。入参用 'cstring'（bun:ffi 自动完成 JS string → C
 * 指针转换；'ptr' 不能直接收 JS 字符串），buf 用 'ptr' 收 Buffer；
 * `async: true` 让 bun:ffi 把调用派发到线程池并返回 Promise。
 */
const SCAN_SYMBOLS = {
  ccb_scan_files_into: {
    args: ['cstring', 'cstring', 'ptr', 'usize'],
    returns: 'isize',
    async: true,
  },
} as const

type ScanFilesFn = (
  root: string,
  excludes: string,
  buf: Buffer,
  bufLen: number,
) => Promise<number>

let cachedScanFn: ScanFilesFn | null = null
let loadAttempted = false

/**
 * bun:ffi 对 memfd ELF 的符号绑定（库已由 process.dlopen 映射进进程）。
 * 64 位整型（isize）返回值是 BigInt——扫描字节数远小于 2^53，包一层
 * Number() 转换，让上层协议逻辑直接用 number。
 */
function bindScanSymbols(path: string): ScanFilesFn | null {
  try {
    const lib = dlopen(path, SCAN_SYMBOLS)
    const raw = lib.symbols.ccb_scan_files_into as unknown as (
      root: string,
      excludes: string,
      buf: Buffer,
      bufLen: number,
    ) => Promise<bigint>
    return async (root, excludes, buf, bufLen) =>
      Number(await raw(root, excludes, buf, bufLen))
  } catch {
    return null
  }
}

/**
 * 把 ELF 写入 Linux memfd，返回 fd（失败返回 null）。memfd_create 通过
 * bun:ffi 直调 libc——MFD_CLOEXEC = 0x0001，进程 exec 后 fd 自动关闭。
 */
function writeElfToMemfd(elf: Buffer): number | null {
  if (process.platform !== 'linux') {
    return null
  }
  try {
    const libc = dlopen('libc.so.6', {
      memfd_create: { args: ['cstring', 'u32'], returns: 'i32' },
    })
    const memfdCreate = libc.symbols.memfd_create as (
      name: string,
      flags: number,
    ) => number
    const fd = memfdCreate('ccb-file-index', 0x0001)
    if (fd < 0) {
      return null
    }
    ftruncateSync(fd, elf.length)
    let written = 0
    while (written < elf.length) {
      written += writeSync(fd, elf, written)
    }
    return fd
  } catch {
    return null
  }
}

function hostTriple(): string | null {
  const arch = process.arch
  switch (process.platform) {
    case 'linux':
      return arch === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : 'x86_64-unknown-linux-gnu'
    case 'darwin':
      return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    case 'win32':
      return 'x86_64-pc-windows-msvc'
    default:
      return null
  }
}

/** dev / 非编译环境的 cargo 产物路径（存在才用）。 */
function devLibraryPath(): string | null {
  const triple = hostTriple()
  if (triple === null) {
    return null
  }
  const fileName =
    process.platform === 'win32'
      ? 'file_index_napi.dll'
      : `libfile_index_napi.${process.platform === 'darwin' ? 'dylib' : 'so'}`
  // src/utils/ffiFileScanner.ts → 上两级到仓库根（dev 模式 import.meta.url
  // 指向源码文件；bundle 环境下该路径不存在，existsSync 淘汰即可）。
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const candidate = join(
    repoRoot,
    'packages',
    'file-index-napi',
    'native',
    'target',
    triple,
    'release',
    fileName,
  )
  return existsSync(candidate) ? candidate : null
}

/**
 * 惰性加载 file-index 原生库并缓存 bun:ffi 符号。返回可调用的扫描符号
 * （ScanFilesFn），加载失败返回 null——调用方降级到 ripgrep 路径。
 */
export function ensureFfiScanner(): unknown | null {
  if (loadAttempted) {
    return cachedScanFn
  }
  loadAttempted = true

  // 1. 编译二进制：内嵌 base64 → memfd → /dev/fd 加载
  if (isCompiledBinary()) {
    const base64 = EMBEDDED_NATIVES['file-index']
    const fd = base64 ? writeElfToMemfd(Buffer.from(base64, 'base64')) : null
    if (fd === null) {
      return null
    }
    // 先按 napi 模块加载（已验证的通道）；即便 napi 注册抛错也不影响
    // 后续 bun:ffi 对同一 /dev/fd 路径的符号绑定（dlopen 引用计数）。
    try {
      const mod = { exports: {} as Record<string, unknown> }
      process.dlopen(mod, `/dev/fd/${fd}`, 0x0001) // RTLD_LAZY = 0x0001
    } catch {
      // ignore — bindScanSymbols 仍可尝试
    }
    cachedScanFn = bindScanSymbols(`/dev/fd/${fd}`)
    return cachedScanFn
  }

  // 2. dev / 非编译：vendor cargo 产物真实路径直接 ffiDlopen
  const candidate = devLibraryPath()
  if (candidate === null) {
    return null
  }
  cachedScanFn = bindScanSymbols(candidate)
  return cachedScanFn
}

// 初始结果缓冲 16MB——覆盖绝大多数项目（约 20 万条绝对路径）。
const INITIAL_BUF_LEN = 16 * 1024 * 1024

/**
 * 并行目录扫描（bun:ffi async → Bun 线程池）。返回绝对路径数组；原生库
 * 不可用、同步抛错、reject、返回 -1 或两次扩容后仍放不下时返回 null，
 * 调用方降级到 ripgrep。
 */
export async function scanProjectFilesFfi(
  root: string,
  excludes: string[],
): Promise<string[] | null> {
  const scan = ensureFfiScanner() as ScanFilesFn | null
  if (scan === null) {
    return null
  }
  const excludesArg = excludes.join('\n')
  // buf 保持局部引用直到调用完成——async 执行期间 bun:ffi 会 pin 住参数，
  // 局部变量足够防止 GC 回收底层内存。
  let buf = Buffer.allocUnsafe(INITIAL_BUF_LEN)
  try {
    let n = await scan(root, excludesArg, buf, buf.length)
    if (n < 0 && n !== -1) {
      // -(所需字节数)：按绝对值扩容重试一次
      buf = Buffer.allocUnsafe(-n)
      n = await scan(root, excludesArg, buf, buf.length)
    }
    if (n < 0) {
      return null
    }
    return buf.toString('utf8', 0, n).split('\n').filter(Boolean)
  } catch {
    return null
  }
}
