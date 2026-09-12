import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Same loading pattern as packages/token-counter-napi (and audio-capture-napi).
const nodeRequire = createRequire(import.meta.url)

function getVendorRoot(): string {
  const filePath = fileURLToPath(import.meta.url)
  const dir = dirname(filePath)
  const parts = dir.split(sep)
  const distIdx = parts.lastIndexOf('dist')
  if (distIdx !== -1) {
    return parts.slice(0, distIdx + 1).join(sep) + sep + 'vendor'
  }
  return resolve(dir, '..', '..', '..', 'vendor')
}

type ChainScan = {
  msgIndex: Uint32Array
  metaRanges: Uint32Array
  keptRanges: Uint32Array
  chainBytes: number
  keepAll: boolean
}

type TranscriptParserNapi = {
  scanChain(buf: Buffer): ChainScan
  hasNativeTranscriptParser(): boolean
}

let cachedModule: TranscriptParserNapi | null = null
let loadAttempted = false

function platformDirName(): string {
  const arch = process.arch
  const platform = process.platform
  if (platform === 'linux') {
    return arch === 'arm64'
      ? 'aarch64-unknown-linux-gnu'
      : 'x86_64-unknown-linux-gnu'
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc'
  }
  return 'unknown'
}

function loadModule(): TranscriptParserNapi | null {
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
    resolve(vendorRoot, 'transcript-parser', triple, 'transcript-parser.node'),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const mod = nodeRequire(candidate) as TranscriptParserNapi
      if (typeof mod?.scanChain !== 'function') continue
      cachedModule = mod
      return cachedModule
    } catch {
      // try next candidate
    }
  }
  return null
}

/**
 * True when the native (Rust) transcript scanner is loaded and callable.
 */
export function isNativeTranscriptParserAvailable(): boolean {
  return loadModule() !== null
}

/**
 * Byte-level chain scan of a transcript buffer.
 * Returns null when the native module is unavailable — callers fall back
 * to the JS byte scanner in that case.
 *
 * parentStart == 0xffffffff in msgIndex means null parent (JS reference
 * uses -1; u32 keeps the array typed).
 */
export function nativeScanChain(buf: Buffer): ChainScan | null {
  const mod = loadModule()
  if (mod === null) return null
  try {
    return mod.scanChain(buf)
  } catch {
    return null
  }
}
