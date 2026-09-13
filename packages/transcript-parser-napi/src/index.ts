import { loadNativeModule } from '../../../src/utils/embeddedNative'

type ChainScan = {
  msgIndex: Uint32Array
  metaRanges: Uint32Array
  keptRanges: Uint32Array
  chainBytes: number
  keepAll: boolean
}

type ChainScanRanges = {
  keptRanges: Uint32Array
  chainBytes: number
  keepAll: boolean
}

type TranscriptParserNapi = {
  scanChain(buf: Buffer): ChainScan
  scanChainRanges?(buf: Buffer): ChainScanRanges
  hasNativeTranscriptParser(): boolean
}

let cachedModule: TranscriptParserNapi | null = null
let loadAttempted = false

function loadModule(): TranscriptParserNapi | null {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  const mod = loadNativeModule<TranscriptParserNapi>(
    'transcript-parser',
    'transcript-parser',
    m => typeof m.scanChain === 'function',
  )
  if (mod) {
    cachedModule = mod
  }
  return cachedModule
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

/**
 * Range-only variant of {@link nativeScanChain}: returns just the kept byte
 * ranges [start, end, ...] pairs so callers can parse zero-copy
 * `buf.subarray(start, end)` views per line instead of materializing a
 * concatenated copy of the active chain. Returns null when the native module
 * is unavailable or predates scanChainRanges — callers fall back to
 * {@link nativeScanChain} or the JS byte scanner.
 */
export function nativeScanChainRanges(buf: Buffer): ChainScanRanges | null {
  const mod = loadModule()
  if (mod === null || typeof mod.scanChainRanges !== 'function') {
    return null
  }
  try {
    return mod.scanChainRanges(buf)
  } catch {
    return null
  }
}
