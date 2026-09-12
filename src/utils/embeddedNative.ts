/**
 * Embedded native module loader for bun --compile binaries.
 *
 * 在 bun --compile 模式下，原生 .node 插件不会自动打包。
 * 本模块在构建时将 .node 编码为 base64 注入二进制，
 * 运行时通过 process.dlopen() 从内存 Buffer 直接加载，
 * **完全不写入临时文件**，实现真正的内嵌加载。
 *
 * Build-time (scripts/compile.ts):
 *   - 读取目标平台的 .node 文件
 *   - 转为 base64，通过 Bun plugin 注入虚拟模块 "embedded:natives"
 *
 * Runtime:
 *   - 检测编译二进制 (Bun.compileTarget)
 *   - 从虚拟模块读取 base64，解码为 Buffer
 *   - 使用 process.dlopen(module, buffer) 从内存直接加载
 *   - 开发/常规构建回退到 vendor/ 目录加载
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const nodeRequire = createRequire(import.meta.url)

// 内嵌原生模块映射（构建时注入）
export type EmbeddedNativeMap = Record<string, string> // moduleName -> base64

// 已加载模块缓存
const loadedCache = new Map<string, unknown>()

/**
 * 检测是否在 bun 编译的二进制中运行
 */
export function isCompiledBinary(): boolean {
  return typeof Bun !== 'undefined' && typeof Bun.compileTarget === 'string'
}

/**
 * 获取内嵌的原生模块映射（构建时注入）
 */
export function getEmbeddedNatives(): EmbeddedNativeMap {
  if (!isCompiledBinary()) {
    return {}
  }
  try {
    const mod = nodeRequire('embedded:natives') as {
      EMBEDDED_NATIVES: EmbeddedNativeMap
    }
    return mod?.EMBEDDED_NATIVES ?? {}
  } catch {
    return {}
  }
}

/**
 * 从内存 Buffer 直接加载原生模块（无临时文件）
 * 使用 Node.js 内部 API process.dlopen(module, buffer)
 * 支持 Node 18+ / Bun 所有版本
 */
function loadNativeFromMemory(moduleName: string, base64: string): unknown {
  const buffer = Buffer.from(base64, 'base64')

  // 创建一个虚拟模块对象供 dlopen 初始化
  const mod = { exports: {} }

  // process.dlopen 是 Node.js 内部 API，支持从 Buffer 直接加载
  // signature: process.dlopen(module: Module, filename: string | Buffer, flags?: number)
  // 当 filename 是 Buffer 时，从内存加载而非磁盘
  try {
    // @ts-expect-error - process.dlopen 是内部 API，支持 Buffer 参数
    process.dlopen(mod, buffer, 0x0001) // RTLD_LAZY = 0x0001
    return mod.exports
  } catch (e) {
    // 某些平台/版本可能不支持 Buffer 参数，抛出错误让上层处理
    throw new Error(`dlopen from memory failed for ${moduleName}: ${e}`)
  }
}

/**
 * 加载原生模块：优先从内存加载（编译二进制），回退到 vendor/ 目录
 */
export function loadNativeModule<T>(
  moduleName: string,
  vendorSubPath: string, // 如 'token-counter', 'transcript-parser', 'color-diff'
  validate: (mod: unknown) => mod is T,
): T | null {
  const cacheKey = `${moduleName}:${vendorSubPath}`

  // 缓存命中
  if (loadedCache.has(cacheKey)) {
    const cached = loadedCache.get(cacheKey)
    if (validate(cached)) return cached as T
  }

  // 1. 编译二进制：从内嵌 base64 直接用 dlopen 从内存加载
  if (isCompiledBinary()) {
    const embedded = getEmbeddedNatives()
    const base64 = embedded[moduleName]
    if (base64) {
      try {
        const mod = loadNativeFromMemory(moduleName, base64)
        if (validate(mod)) {
          loadedCache.set(cacheKey, mod)
          return mod as T
        }
      } catch (e) {
        console.error(`[embedded-native] 内存加载失败 ${moduleName}:`, e)
        // 继续尝试 vendor 回退
      }
    }
  }

  // 2. 开发/常规构建：从 vendor/ 目录加载
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
      const mod = nodeRequire(candidate)
      if (validate(mod)) {
        loadedCache.set(cacheKey, mod)
        return mod as T
      }
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
