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

type TranscriptWindow = {
  tailRanges: Uint32Array
  totalChainCount: number
  beforeWindowCount: number
  windowStartUuid: string
  parentOfFirst: string
}

type TranscriptWindowLoad = {
  tailLines: string[]
  metaLines: string[]
  totalChainCount: number
  beforeWindowCount: number
  windowStartUuid: string
  parentOfFirst: string
  fileBytes: number
}

type TranscriptParserNapi = {
  scanChain(buf: Buffer): ChainScan
  scanChainRanges?(buf: Buffer): ChainScanRanges
  scanTranscriptWindow?(buf: Buffer, tailCount: number): TranscriptWindow
  loadTranscriptWindowFromFile?(
    path: string,
    tailCount: number,
  ): TranscriptWindowLoad
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
 * Legacy full-scan wrapper, kept as public API. Its underlying `scanChain`
 * export is also the fallback that powers {@link nativeScanChainRanges} on
 * .node builds predating `scanChainRanges` — same byte-identical scan, just
 * returns the extra msgIndex/metaRanges the range-only variant skips.
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
 * concatenated copy of the active chain.
 *
 * Fallback chain: native module missing → null (callers use the JS byte
 * scanner); module predates `scanChainRanges` or the call fails → legacy
 * {@link nativeScanChain} scan, re-shaped to the range-only result (same
 * scan, same kept-ranges/keepAll semantics — see ChainScan). Never throws.
 */
export function nativeScanChainRanges(buf: Buffer): ChainScanRanges | null {
  const mod = loadModule()
  if (mod === null) return null
  if (typeof mod.scanChainRanges === 'function') {
    try {
      return mod.scanChainRanges(buf)
    } catch {
      // Fall through to the legacy scanChain export below — same scan.
    }
  }
  const legacy = nativeScanChain(buf)
  if (legacy === null) return null
  return {
    keptRanges: legacy.keptRanges,
    chainBytes: legacy.chainBytes,
    keepAll: legacy.keepAll,
  }
}

/**
 * Window over the active chain: byte ranges of the last `tailCount` chain
 * messages plus anchors (windowStartUuid/parentOfFirst) for loading earlier
 * messages on demand. Lets a session resume materialize only the visible
 * tail instead of the whole message graph.
 *
 * Fallback chain: native module missing / predates scanTranscriptWindow /
 * call fails → null (callers use the full-parse path). Never throws.
 */
export function nativeScanTranscriptWindow(
  buf: Buffer,
  tailCount: number,
): TranscriptWindow | null {
  const mod = loadModule()
  if (mod === null) return null
  if (typeof mod.scanTranscriptWindow === 'function') {
    try {
      return mod.scanTranscriptWindow(buf, tailCount)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Full-pipeline window load, Rust side owns the file I/O: read → line
 * classification → active-chain walk → tail window. Only the window's
 * message lines and the small metadata lines cross the ABI — the JS heap
 * never materializes the full buffer or message graph.
 *
 * Fallback: native module missing / predates this export / call fails →
 * null (callers use the JS full-parse path). Never throws.
 */
export function nativeLoadTranscriptWindowFromFile(
  path: string,
  tailCount: number,
): TranscriptWindowLoad | null {
  const mod = loadModule()
  if (mod === null) return null
  if (typeof mod.loadTranscriptWindowFromFile === 'function') {
    try {
      return mod.loadTranscriptWindowFromFile(path, tailCount)
    } catch {
      return null
    }
  }
  return null
}
