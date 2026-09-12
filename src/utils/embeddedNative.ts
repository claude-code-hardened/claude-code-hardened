/**
 * Embedded native module loader for bun --compile binaries.
 *
 * 在 bun --compile 模式下，原生 .node 插件不会自动打包。
 * 本模块配合 src/utils/embeddedNatives.gen.ts（构建时被 plugin 覆盖注入）
 * 在运行时通过 process.dlopen(module, buffer) 从内存 Buffer 直接加载，
 * **完全不写入临时文件**，实现真正的内嵌加载。
 *
 * Build-time (scripts/compile.ts):
 *   - 读取目标平台的 .node 文件
 *   - 转为 base64，通过 Bun plugin 覆盖 embeddedNatives.gen 模块内容
 *
 * Runtime:
 *   - EMBEDDED_NATIVES 非空 → 编译二进制 → 解码 base64 → dlopen 内存加载
 *   - EMBEDDED_NATIVES 为空 → dev / 常规构建 → 回退 vendor/ 目录加载
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMBEDDED_NATIVES } from './embeddedNatives.gen'

const nodeRequire = createRequire(import.meta.url)

// 已加载模块缓存
const loadedCache = new Map<string, unknown>()

/**
 * 检测是否在 bun 编译的二进制中运行：
 * 编译时 plugin 注入了非空 EMBEDDED_NATIVES；dev/常规构建下恒为空对象。
 */
export function isCompiledBinary(): boolean {
  return Object.keys(EMBEDDED_NATIVES).length > 0
}

type NativeModuleLike = Record<string, unknown>

/**
 * 从内存 Buffer 直接加载原生模块（无临时文件）
 * 使用 Node.js 内部 API process.dlopen(module, buffer)
 * 当第二个参数是 Buffer 时，从内存加载而非磁盘
 */
function loadNativeFromMemory(
  moduleName: string,
  base64: string,
): NativeModuleLike {
  const buffer = Buffer.from(base64, 'base64')

  // 创建一个虚拟模块对象供 dlopen 初始化
  const mod = { exports: {} as NativeModuleLike }

  try {
    // @ts-expect-error — process.dlopen 是内部 API；Buffer 重载在类型定义中缺失
    process.dlopen(mod, buffer, 0x0001) // RTLD_LAZY = 0x0001
  } catch (e) {
    throw new Error(`dlopen from memory failed for ${moduleName}: ${e}`)
  }
  return mod.exports
}

/**
 * 加载原生模块：优先从内存加载（编译二进制），回退到 vendor/ 目录
 */
export function loadNativeModule<T>(
  moduleName: string,
  vendorSubPath: string, // 如 'token-counter', 'transcript-parser', 'color-diff'
  validate: (mod: NativeModuleLike) => boolean,
): T | null {
  const cacheKey = `${moduleName}:${vendorSubPath}`

  // 缓存命中
  const cached = loadedCache.get(cacheKey)
  if (cached !== undefined && validate(cached as NativeModuleLike)) {
    return cached as T
  }

  const accept = (mod: unknown): T | null => {
    if (
      mod !== null &&
      typeof mod === 'object' &&
      validate(mod as NativeModuleLike)
    ) {
      loadedCache.set(cacheKey, mod)
      return mod as T
    }
    return null
  }

  // 1. 编译二进制：从内嵌 base64 直接用 dlopen 从内存加载
  if (isCompiledBinary()) {
    const base64 = EMBEDDED_NATIVES[moduleName]
    if (base64) {
      try {
        const fromMemory = accept(loadNativeFromMemory(moduleName, base64))
        if (fromMemory) return fromMemory
      } catch (e) {
        console.error(`[embedded-native] 内存加载失败 ${moduleName}:`, e)
        // 继续尝试 vendor 回退
      }
    }
  }

  // 2. dev / 常规构建：从 vendor/ 目录加载
  try {
    const filePath = fileURLToPath(import.meta.url)
    const dir = dirname(filePath)
    const parts = dir.split(sep)
    const distIdx = parts.lastIndexOf('dist')
    const vendorRoot =
      distIdx !== -1
        ? parts.slice(0, distIdx + 1).join(sep) + sep + 'vendor'
        : resolve(dir, '..', '..', '..', 'vendor')

    const arch = process.arch
    const platform = process.platform
    let triple: string
    if (platform === 'linux') {
      triple =
        arch === 'arm64'
          ? 'aarch64-unknown-linux-gnu'
          : 'x86_64-unknown-linux-gnu'
    } else if (platform === 'darwin') {
      triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    } else if (platform === 'win32') {
      triple = 'x86_64-pc-windows-msvc'
    } else {
      return null
    }

    const candidate = resolve(
      vendorRoot,
      vendorSubPath,
      triple,
      `${moduleName}.node`,
    )
    if (existsSync(candidate)) {
      const fromVendor = accept(nodeRequire(candidate))
      if (fromVendor) return fromVendor
    }
  } catch {
    // ignore
  }

  return null
}

// 导出给加载器使用的路径工具
export { createRequire } from 'node:module'
export { existsSync } from 'node:fs'
export { dirname, resolve, sep } from 'node:path'
export { fileURLToPath } from 'node:url'
