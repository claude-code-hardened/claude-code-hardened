import { loadNativeModule } from '../../src/utils/embeddedNative'

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
