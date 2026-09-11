import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// createRequire works in both Bun and Node.js ESM contexts.
// Needed because this package is "type": "module" but uses require() for
// loading native .node addons — bare require is not available in Node.js ESM.
const nodeRequire = createRequire(import.meta.url)

/**
 * Resolve the "vendor root" directory where native .node binaries live.
 *
 * - Dev mode:  import.meta.url → packages/token-counter-napi/src/index.ts
 *              → vendor root = <project>/vendor/
 * - Bun build: import.meta.url → dist/chunk-xxx.js
 *              → vendor root = <project>/dist/vendor/
 * - Vite build: import.meta.url → dist/chunks/chunk-xxx.js
 *              → vendor root = <project>/dist/vendor/
 *
 * Mirrors packages/audio-capture-napi/src/index.ts getVendorRoot().
 */
function getVendorRoot(): string {
  const filePath = fileURLToPath(import.meta.url)
  const dir = dirname(filePath)
  const parts = dir.split(sep)
  const distIdx = parts.lastIndexOf('dist')
  if (distIdx !== -1) {
    return parts.slice(0, distIdx + 1).join(sep) + sep + 'vendor'
  }
  // Dev mode — go up from packages/token-counter-napi/src/ to project root
  return resolve(dir, '..', '..', '..', 'vendor')
}

type TokenCounterNapi = {
  countTokens(text: string): number
  countTokensBatch?(texts: string[]): number[]
  isNativeTokenizer?(): boolean
}

let cachedModule: TokenCounterNapi | null = null
let loadAttempted = false

function platformDirName(): string {
  // vendor/<name>/<triple>/<name>.node — triple 由 CI 构建矩阵决定。
  // 运行时按 platform/arch 映射到 CI 产出的 triple 目录名。
  const arch = process.arch // 'arm64' | 'x64'
  const platform = process.platform
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc'
  }
  return 'unknown'
}

function loadModule(): TokenCounterNapi | null {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return null
  }

  const triple = platformDirName()
  const vendorRoot = getVendorRoot()
  const candidates = [
    resolve(vendorRoot, 'token-counter', triple, 'token-counter.node'),
    // Relative fallbacks for non-standard checkout layouts.
    resolve(vendorRoot, '..', 'vendor', 'token-counter', triple, 'token-counter.node'),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const mod = nodeRequire(candidate) as TokenCounterNapi
      if (typeof mod?.countTokens !== 'function') continue
      cachedModule = mod
      return cachedModule
    } catch {
      // try next candidate
    }
  }
  return null
}

/**
 * True when the native (Rust) tokenizer module is loaded and callable.
 * Never throws — callers can treat this as a cheap capability probe.
 */
export function isNativeTokenizerAvailable(): boolean {
  return loadModule() !== null
}

/**
 * Count tokens using the native BPE tokenizer.
 * Returns null when the native module is unavailable — callers fall back
 * to rough estimation in that case.
 */
export function nativeCountTokens(text: string): number | null {
  const mod = loadModule()
  if (mod === null) return null
  try {
    return mod.countTokens(text)
  } catch {
    return null
  }
}

/**
 * Batch count tokens in a single native call (amortizes boundary cost).
 * Returns null when unavailable or when the native module lacks batch support.
 */
export function nativeCountTokensBatch(texts: string[]): number[] | null {
  const mod = loadModule()
  if (mod === null || typeof mod.countTokensBatch !== 'function') return null
  try {
    return mod.countTokensBatch(texts)
  } catch {
    return null
  }
}
