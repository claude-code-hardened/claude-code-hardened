import { LRUCache } from 'lru-cache'

// Defaults picked so the worst-case retained footprint of a component-level
// cache is ~8 MiB while a single entry (e.g. one token tree, one ColorFile)
// above 1 MiB stops being worth caching — re-computing it is cheaper than
// pinning it in heap indefinitely.
export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_ITEM_BYTES = 1 * 1024 * 1024

export type ByteBudgetCacheOptions<K extends {}, V> = {
  /**
   * Total estimated bytes retained across all values. Insertion of an entry
   * that pushes the total over this evicts least-recently-used entries until
   * it fits. Default: DEFAULT_MAX_TOTAL_BYTES (8 MiB).
   */
  maxTotalBytes?: number
  /**
   * Max estimated bytes for a single value. Larger values are never stored:
   * set() is a no-op and callers keep computing fresh each call, so one giant
   * entry cannot evict (or zero out) the whole budget on its own. Default:
   * DEFAULT_MAX_ITEM_BYTES (1 MiB).
   */
  maxItemBytes?: number
  /**
   * Rough retained size of a value in bytes. Must be deterministic per value
   * (insert and eviction accounting both use it). Estimates are allowed to be
   * imprecise — they only need to scale with actual retained memory.
   */
  estimateSize: (value: V, key: K) => number
}

/**
 * Map-shaped cache bounded by an estimated byte budget instead of an entry
 * count. get/has/delete/clear match Map semantics; set returns whether the
 * value was stored (false when the value exceeds the per-item budget), since
 * the caller usually wants the value regardless of caching. get() refreshes
 * LRU recency.
 */
export type ByteBudgetCache<K extends {}, V> = {
  get: (key: K) => V | undefined
  set: (key: K, value: V) => boolean
  has: (key: K) => boolean
  delete: (key: K) => boolean
  clear: () => void
  readonly size: number
  /** Current running total of estimateSize() over retained entries. */
  readonly bytes: number
}

/**
 * Create a byte-budgeted LRU cache. Backed by lru-cache's maxSize +
 * maxEntrySize accounting, which both evicts LRU entries on overflow and
 * skips insertion of oversized entries natively.
 */
export function createByteBudgetCache<K extends {}, V extends {}>(
  opts: ByteBudgetCacheOptions<K, V>,
): ByteBudgetCache<K, V> {
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  // Clamp the per-item limit to the total budget so an internally-cached
  // entry can never exceed maxSize (lru-cache would otherwise have to evict
  // everything to admit it).
  const itemLimit = Math.min(
    opts.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES,
    maxTotalBytes,
  )
  // lru-cache requires every computed size to be a positive integer.
  const sizeOf = (value: V, key: K): number =>
    Math.max(1, Math.floor(opts.estimateSize(value, key)))

  const cache = new LRUCache<K, V>({
    maxSize: maxTotalBytes,
    maxEntrySize: itemLimit,
    sizeCalculation: sizeOf,
  })

  return {
    get: key => cache.get(key),
    set: (key, value) => {
      // Pre-check for the boolean return; maxEntrySize enforces the same
      // limit internally as a safety net.
      if (sizeOf(value, key) > itemLimit) {
        return false
      }
      cache.set(key, value)
      return true
    },
    has: key => cache.has(key),
    delete: key => cache.delete(key),
    clear: () => cache.clear(),
    get size() {
      return cache.size
    },
    get bytes() {
      return cache.calculatedSize
    },
  }
}
