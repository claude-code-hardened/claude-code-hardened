/**
 * Native-backed wrapper around the Rust file-index module
 * (packages/file-index-napi/native). Behavior-identical surface to the TS
 * `FileIndex` (src/native-ts/file-index/index.ts), which remains the
 * fallback when the native module is unavailable.
 *
 * The Rust side is a line-by-line port of the TS scoring algorithm (NOT
 * nucleo's matcher), so search results are byte-identical; the differential
 * script (scripts/differential.ts) asserts that over real path corpora.
 *
 * Division of labor inside this wrapper:
 *   - non-empty queries → native `search` (the hot path, <1ms on 270k paths)
 *   - empty queries → TS `computeTopLevelEntries` over the full deduped list
 *     (computed at reset time, exactly like the TS class, so results are
 *     complete even while the async build is still appending chunks)
 *   - async build → JS-driven chunking (dedupe + event-loop yields mirror
 *     TS buildAsync), each chunk appended to the native index in one call
 */
import {
  CHUNK_MS,
  computeTopLevelEntries,
  TOP_LEVEL_CACHE_LIMIT,
  yieldToEventLoop,
} from '../../../src/native-ts/file-index/index'
import { loadNativeModule } from '../../../src/utils/embeddedNative'

export type FileSearchResult = {
  path: string
  score: number
}

/**
 * Structural type shared by the TS `FileIndex` fallback and the native
 * wrapper — callers hold either behind this interface.
 */
export interface FileIndexLike {
  loadFromFileList(fileList: string[]): void
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>
    done: Promise<void>
  }
  search(query: string, limit: number): FileSearchResult[]
  /** Only the native wrapper implements this (eager memory release). */
  free?(): void
}

type NativeIndexHandle = {
  loadFromFileList(paths: string[]): void
  appendPaths(paths: string[]): void
  search(query: string, limit: number): FileSearchResult[]
  pathCount(): number
  free(): void
}

type NativeFileIndexModule = {
  createNativeFileIndex(): NativeIndexHandle
  isNativeFileIndex(): boolean
}

/**
 * `scan_project_files` export (added later than the index surface). Validated
 * separately so an older embedded binary without the export still loads the
 * index module — only the scan degrades to the caller's fallback.
 */
type NativeScanModule = {
  scanProjectFiles(root: string, excludes: string[]): Promise<string[]>
}

let cachedModule: NativeFileIndexModule | null = null
let loadAttempted = false

function loadModule(): NativeFileIndexModule | null {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  const mod = loadNativeModule<NativeFileIndexModule>(
    'file-index',
    'file-index',
    m =>
      typeof m.createNativeFileIndex === 'function' &&
      typeof m.isNativeFileIndex === 'function',
  )
  if (mod) {
    cachedModule = mod
  }
  return cachedModule
}

let cachedScanModule: NativeScanModule | null = null
let scanLoadAttempted = false

function loadScanModule(): NativeScanModule | null {
  if (scanLoadAttempted) {
    return cachedScanModule
  }
  scanLoadAttempted = true

  // Same underlying .node (same cache key in loadNativeModule) — only the
  // validator differs. When the shared cache already holds a newer binary
  // both validators pass and the instance is reused.
  const mod = loadNativeModule<NativeScanModule>(
    'file-index',
    'file-index',
    m => typeof m.scanProjectFiles === 'function',
  )
  if (mod) {
    cachedScanModule = mod
  }
  return cachedScanModule
}

/**
 * Parallel directory scan of `root` in the Rust thread pool (jwalk walk
 * behind `scan_project_files`). Resolves to absolute file paths in the same
 * shape `rg --files --follow --hidden` produces, with whole subtrees pruned
 * by directory name from `excludes`. Returns null (caller falls back to the
 * ripgrep subprocess path) when the native module is missing or throws
 * synchronously; async failures surface as a rejected promise.
 */
export function scanProjectFilesNative(
  root: string,
  excludes: string[],
): Promise<string[]> | null {
  const mod = loadScanModule()
  if (mod === null) {
    return null
  }
  try {
    return mod.scanProjectFiles(root, excludes)
  } catch {
    return null
  }
}

// One native append per chunk (~2ms for 16k paths), yielding to the event
// loop between chunks — mirrors the TS buildAsync CHUNK_MS cadence.
const APPEND_CHUNK = 16384

export class NativeFileIndex implements FileIndexLike {
  private handle: NativeIndexHandle | null = null
  private topLevelCache: FileSearchResult[] = []

  loadFromFileList(fileList: string[]): void {
    const paths = dedupePaths(fileList)
    const fresh = this.createHandle()
    if (fresh === null) {
      return
    }
    try {
      fresh.loadFromFileList(paths)
      // Observable state is only touched after the load succeeds: any
      // failure above must leave the previous index AND top-level cache
      // fully intact (mixing an old handle with a new cache would make
      // empty vs non-empty queries disagree).
      this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT)
    } catch {
      // free() is implemented and idempotent on the native side — release
      // the fresh handle; the old state keeps serving unchanged.
      try {
        fresh.free()
      } catch {
        // already released — ignore
      }
      return
    }
    this.swapHandle(fresh)
  }

  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>
    done: Promise<void>
  } {
    let markQueryable: () => void = () => {}
    const queryable = new Promise<void>(resolve => {
      markQueryable = resolve
    })
    const done = this.buildAsync(fileList, markQueryable)
    return { queryable, done }
  }

  search(query: string, limit: number): FileSearchResult[] {
    if (limit <= 0) {
      return []
    }
    if (query.length === 0) {
      return this.topLevelCache.slice(0, limit)
    }
    const handle = this.handle
    if (handle === null) {
      return []
    }
    try {
      return handle.search(query, limit)
    } catch {
      return []
    }
  }

  /** Release the native index memory eagerly (session cache reset). */
  free(): void {
    const handle = this.handle
    this.handle = null
    this.topLevelCache = []
    if (handle !== null) {
      try {
        handle.free()
      } catch {
        // already released — ignore
      }
    }
  }

  private createHandle(): NativeIndexHandle | null {
    const mod = loadModule()
    if (mod === null) {
      return null
    }
    try {
      return mod.createNativeFileIndex()
    } catch {
      return null
    }
  }

  private swapHandle(next: NativeIndexHandle): void {
    const old = this.handle
    this.handle = next
    if (old !== null) {
      try {
        old.free()
      } catch {
        // ignore — replaced index must never outlive this call
      }
    }
  }

  private async buildAsync(
    fileList: string[],
    markQueryable: () => void,
  ): Promise<void> {
    // Phase 1 — dedupe with event-loop yields (mirrors TS buildAsync: the
    // previous index stays fully searchable during this phase).
    const seen = new Set<string>()
    const paths: string[] = []
    let chunkStart = performance.now()
    for (let i = 0; i < fileList.length; i++) {
      const line = fileList[i]!
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }

    // Phase 2 — resetArrays equivalent: the empty-query cache is rebuilt from
    // the complete deduped list immediately, and a fresh native handle takes
    // over (non-empty searches see the appended prefix while building).
    this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT)
    const fresh = this.createHandle()
    if (fresh === null) {
      // The new cache is already published, so the old index must not
      // survive — keeping it would pair a stale handle with the fresh cache
      // (empty vs non-empty queries would disagree). Release it and null the
      // slot; every query converges to empty results until a rebuild
      // succeeds.
      this.free()
      markQueryable()
      return
    }
    this.swapHandle(fresh)

    // Phase 3 — chunked append (indexPath equivalent).
    let firstChunk = true
    for (let i = 0; i < paths.length; i += APPEND_CHUNK) {
      fresh.appendPaths(paths.slice(i, i + APPEND_CHUNK))
      if (firstChunk) {
        markQueryable()
        firstChunk = false
      }
      await yieldToEventLoop()
    }
    markQueryable()
  }
}

function dedupePaths(fileList: string[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const line of fileList) {
    if (line.length > 0 && !seen.has(line)) {
      seen.add(line)
      paths.push(line)
    }
  }
  return paths
}

/**
 * Construct a native-backed index. Returns null when the native module is
 * unavailable — callers fall back to the TS FileIndex.
 */
export function createNativeFileIndex(): NativeFileIndex | null {
  if (loadModule() === null) {
    return null
  }
  return new NativeFileIndex()
}
