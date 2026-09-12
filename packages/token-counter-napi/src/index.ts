import { loadNativeModule } from '../../src/utils/embeddedNative'

type TokenCounterNapi = {
  countTokens(text: string): number
  countTokensBatch?(texts: string[]): number[]
  isNativeTokenizer?(): boolean
}

let cachedModule: TokenCounterNapi | null = null
let loadAttempted = false

function loadModule(): TokenCounterNapi | null {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  const mod = loadNativeModule<TokenCounterNapi>(
    'token-counter',
    'token-counter',
    m => typeof m.countTokens === 'function',
  )
  if (mod) {
    cachedModule = mod
  }
  return cachedModule
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
