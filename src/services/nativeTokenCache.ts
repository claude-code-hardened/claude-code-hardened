import { createByteBudgetCache } from '../utils/cacheBudget.js'
import { hashContent } from '../utils/hash.js'

/**
 * Byte-budgeted LRU cache for native (Rust BPE) token counts, keyed by a
 * short content hash instead of the raw text.
 *
 * Why not key by the content string (the pre-M3 implementation was a plain
 * `Map<string, number>` capped at 512 entries): Map keys are strong
 * references, so after MEMORY_PROJECTION releases the tool_result originals
 * (query.ts post-microcompact release point, query.ts:626-654 — and
 * clearToolResultProjection in microCompact.ts), this cache was regularly the
 * LAST strong-reference holder of multi-hundred-KB tool_result texts. With a
 * 512-entry cap that is a potential hundreds-of-MB permanent residency.
 *
 * The fix (heads the repo-wide cache doctrine of
 * src/utils/cacheBudget.ts):
 *   1. key shortening  — key = wyhash64(content) + ':' + length via
 *      hashContent() (repo-standard, Bun.hash with a sha256 fallback); the
 *      full content is never retained, so the GC can reclaim it as soon as
 *      the projection clears it. Hit-rate semantics are unchanged: identical
 *      content yields an identical key (collisions at 64-bit are negligible;
 *      the length suffix narrows them further).
 *   2. byte cap         — each entry is charged with the byte length of the
 *      content its count was computed from, so the cache never "stands for"
 *      more than maxTotalBytes of unique content (default 8 MiB, matching
 *      DEFAULT_MAX_TOTAL_BYTES). A single content above maxItemBytes (default
 *      1 MiB) is counted but NOT stored — it recomputes every time instead of
 *      pinning the whole budget.
 *   3. LRU eviction     — get() refreshes recency; insertion past the budget
 *      evicts least-recently-used entries (createByteBudgetCache semantics).
 */

/** Flat per-entry charge for the hash key + {count, contentBytes} wrapper. */
const KEY_WRAPPER_OVERHEAD_BYTES = 64

type NativeTokenCacheEntry = {
  count: number
  /** Content length the count was computed from — the budget's charge unit. */
  contentBytes: number
}

export type NativeTokenCache = {
  /**
   * Cached count for `content`, or undefined on miss. A hit refreshes LRU
   * recency — identical hit/miss semantics to the pre-M3 Map.
   */
  get: (content: string) => number | undefined
  /**
   * Store a count for `content`. Returns false (without storing) when the
   * content exceeds the per-item budget; callers keep the freshly computed
   * count either way.
   */
  set: (content: string, count: number) => boolean
  clear: () => void
  readonly size: number
  /** Current running total of the byte budget (entry charges). */
  readonly bytes: number
}

export type NativeTokenCacheOptions = {
  maxTotalBytes?: number
  maxItemBytes?: number
}

/** Shortened cache key: 64-bit content hash + length, never the content. */
export function nativeTokenCacheKey(content: string): string {
  return `${hashContent(content)}:${content.length}`
}

/** Create a byte-budgeted native-token-count cache (short keys + LRU). */
export function createNativeTokenCache(
  opts: NativeTokenCacheOptions = {},
): NativeTokenCache {
  const cache = createByteBudgetCache<string, NativeTokenCacheEntry>({
    maxTotalBytes: opts.maxTotalBytes,
    maxItemBytes: opts.maxItemBytes,
    estimateSize: entry => entry.contentBytes + KEY_WRAPPER_OVERHEAD_BYTES,
  })
  return {
    get: content => cache.get(nativeTokenCacheKey(content))?.count,
    set: (content, count) =>
      cache.set(nativeTokenCacheKey(content), {
        count,
        contentBytes: content.length,
      }),
    clear: () => cache.clear(),
    get size() {
      return cache.size
    },
    get bytes() {
      return cache.bytes
    },
  }
}
