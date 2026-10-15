import type { ColorFile as ColorFileType } from 'color-diff-napi'
import {
  createByteBudgetCache,
  type ByteBudgetCache,
} from '../../utils/cacheBudget.js'

export type ColorFileCacheEntry = {
  colorFile: ColorFileType
  code: string
}

/** JS strings are UTF-16: 2 bytes per character of the retained code copy. */
const CODE_BYTES_PER_CHAR = 2

/**
 * Flat estimate for one napi ColorFile handle: the JS wrapper object plus the
 * native-side parsed syntax structures it keeps alive. Native allocations are
 * not observable from JS, so a conservative constant (4 KiB) is charged per
 * entry rather than pretending to measure them.
 */
const COLOR_FILE_HANDLE_OVERHEAD_BYTES = 4096

/**
 * Rough retained size of one cache entry: the cached `code` string × 2 bytes
 * (UTF-16) plus a fixed 4 KiB for the napi ColorFile handle. The estimate is
 * intentionally coarse — native parse trees scale with code length approximately,
 * which is what the code.length term models; the flat overhead keeps tiny
 * snippets from costing "zero" in the budget.
 */
export function estimateColorFileEntrySize(
  entry: ColorFileCacheEntry,
): number {
  return (
    entry.code.length * CODE_BYTES_PER_CHAR + COLOR_FILE_HANDLE_OVERHEAD_BYTES
  )
}

export type ColorFileCache = ByteBudgetCache<string, ColorFileCacheEntry>

export type ColorFileCacheOptions = {
  maxTotalBytes?: number
  maxItemBytes?: number
}

/** Create a byte-budgeted ColorFile cache (defaults: 8 MiB total, 1 MiB/item). */
export function createColorFileCache(
  opts: ColorFileCacheOptions = {},
): ColorFileCache {
  return createByteBudgetCache<string, ColorFileCacheEntry>({
    maxTotalBytes: opts.maxTotalBytes,
    maxItemBytes: opts.maxItemBytes,
    estimateSize: estimateColorFileEntrySize,
  })
}

/**
 * Cache key: file path + code length. Same path + same length does not prove
 * same content, so entries retain `code` and the lookup below re-verifies it
 * before reusing an instance.
 */
export function colorFileCacheKey(filePath: string, code: string): string {
  return `${filePath}\0${code.length}`
}

/**
 * Return the cached ColorFile for (code, filePath), constructing one on miss.
 * Pure cache logic so the component stays render-only: get() hits return the
 * exact same instance and refresh LRU recency; misses construct a fresh
 * instance via the ColorFile constructor. Values whose estimate exceeds the
 * per-item budget are returned but not stored — an oversized file re-parses on
 * every render instead of pinning ~1 MB (or more) of code in the cache.
 */
export function getCachedColorFileInstance(
  cache: ColorFileCache,
  ColorFile: new (code: string, filePath: string) => ColorFileType,
  code: string,
  filePath: string,
): ColorFileType {
  const cacheKey = colorFileCacheKey(filePath, code)
  const cached = cache.get(cacheKey)
  if (cached && cached.code === code) {
    return cached.colorFile
  }
  const instance = new ColorFile(code, filePath)
  cache.set(cacheKey, { colorFile: instance, code })
  return instance
}
