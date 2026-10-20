/**
 * search-napi TS wrapper — native loader + rg-byte-format renderer.
 *
 * Loads the Rust search engine (packages/search-napi/native) via the shared
 * embedded/vendor loader and renders native `GrepMatch` rows into the exact
 * byte shapes the rg subprocess path in GrepTool produces today, so the
 * existing line parser (splitContentLine / relativeContentLine / count
 * colon-parse) round-trips every line we emit.
 *
 * Division of labor:
 *   - loadSearchNative() — narrow validate probe over the frozen v1 surface
 *     (grepSearch / findGlob / searchCancel). Any structural deviation makes
 *     calls return null so Callers fall back to rg instead of silently
 *     accepting a fake native module.
 *   - attachSearchCancel() — one-shot abortSignal → mod.searchCancel(key)
 *     hookup (Rust heart.rs CancelRegistry flags the session's cancel slot;
 *     pipelines poll SearchToken).
 *   - renderGrepMatches() — pure function, byte-aligned to vendored rg
 *     14.1.1 (probed format anchors, see comments at each branch):
 *       content match line   `path:line:text`      ( `-n` colon rule)
 *       context line         `path-line-text`      (hyphen, no colon → the
 *                             parser passes it through untouched, same as rg)
 *       group separator      `--`                  (only when context was
 *                             requested; between files always, within a file
 *                             only across a line gap — matches rg's
 *                             --context-separator semantics)
 *       count line           `path:count`          (bare `count` when the
 *                             search root is a single file, like `rg -c FILE`)
 *       files_with_matches   one bare path per line
 *       truncated match      `[Omitted long matching line]` (verbatim rg 14.1.1)
 *       binary notice        `path\0binary file matches (found "\0" byte
 *                             around offset N)` — official uOn emits this on
 *                             the ripgrep end event when binary_offset is set,
 *                             only for files that yielded output lines
 *                             (reverse-284 _ALL.js:9463). 官方截断阈值
 *                             `U.length>500`（[Omitted long …] 行）原样保留；
 *                             max_columns 工具面可调是 CCH 既有差异（官方
 *                             写死 500），注释声明。
 *     Binary files: the native pipeline runs BinaryDetection::quit(0) and now
 *     surfaces the quit offset per file (GrepResult.binaryNotices) so the
 *     host can print the same-text notice the rg subprocess path produced
 *     (Content mode only — rg -c/-l print no notice).
 */
import { loadNativeModule } from '../../../src/utils/embeddedNative'

/**
 * Serialized `#[napi(string_enum)] GrepOutputMode` — napi-rs string_enum
 * emits the Rust variant names verbatim (types.rs has no #[napi(value)]
 * overrides, unlike omp which lowercases).
 */
export type GrepOutputModeValue = 'Content' | 'FilesWithMatches' | 'Count'

/** Mirror of napi `#[napi(object)] GrepOptions` (snake_case → camelCase). */
export interface GrepOptionsLike {
  pattern: string
  path?: string | null
  glob?: string | null
  type?: string | null
  ignoreCase?: boolean | null
  multiline?: boolean | null
  hidden?: boolean | null
  gitignore?: boolean | null
  maxCount?: number | null
  offset?: number | null
  contextBefore?: number | null
  contextAfter?: number | null
  maxColumns?: number | null
  /** ugrep -o: content mode prints matched segments, count counts segments. */
  onlyMatching?: boolean | null
  /** ugrep -L: zero-match files are listed; mutual exclusion with files_with_matches mode (native errors "mutually exclusive"). */
  filesWithoutMatch?: boolean | null
  /** ugrep -I: probe first 8KiB for NUL (no BOM) → skip the whole file and continue. */
  binarySkip?: boolean | null
  mode?: GrepOutputModeValue | null
  timeoutMs?: number | null
  /** Per-session cancel key (CancelRegistry): searchCancel(key) kills only this call. */
  cancelKey?: string | null
}

/** Mirror of napi `#[napi(object)] GlobOptions`. */
export interface GlobOptionsLike {
  pattern?: string | null
  path?: string | null
  type?: string | null
  hidden?: boolean | null
  gitignore?: boolean | null
  sortByMtime?: boolean | null
  maxResults?: number | null
  offset?: number | null
  timeoutMs?: number | null
  /** bfs `-name` face: basename fnmatch (orthogonal to `pattern` path glob). */
  bfsName?: string | null
  /** bfs `-iname`: case-insensitive `bfsName`. */
  bfsIcase?: boolean | null
  /** bfs `-mindepth` (root = 0; shallower entries skipped, traversal continues). */
  minDepth?: number | null
  /** bfs `-maxdepth` (root = 0; dirs at depth == max are emitted but not descended; intersected with the include-face derived bound). */
  maxDepth?: number | null
  /** Symlink policy: `"P"` (default, never follow; symlinks report type `l`) | `"L"` (follow all + loop guard) | `"H"` (follow roots only). */
  follow?: string | null
  /** Emit order: `"bfs"` (default; (depth, parent seq, name) layer order) | `"dfs"` (legacy WalkParallel + lexicographic fallback). */
  order?: string | null
  /** Per-session cancel key (CancelRegistry): searchCancel(key) kills only this call. */
  cancelKey?: string | null
}

/** Mirror of napi `#[napi(object)] GrepMatch`. */
export interface RenderableGrepMatch {
  path: string
  lineNumber: number
  /** Count mode: per-file match count; other modes: shared line content. */
  line: string
  before: string[]
  after: string[]
  /** The line hit the max_columns cap (native truncates it). */
  truncated?: boolean | null
}

/** Mirror of napi `#[napi(object)] BinaryMatchNotice`. */
export interface BinaryMatchNoticeLike {
  path: string
  offset: number
}

/** Mirror of napi `#[napi(object)] GrepResult`. */
export interface GrepResultLike {
  matches: RenderableGrepMatch[]
  totalMatches: number
  filesWithMatches: number
  filesSearched: number
  limitReached: boolean
  skippedOversized: number
  /** Pipeline was cancelled (searchCancel / timeout) — result is a truncated residual, not a clean empty set. */
  cancelled?: boolean | null
  /**
   * Per-file BinaryDetection::quit offsets (older .node payloads lack the
   * field — undefined degrades to "no notices", matching the v0 divergence
   * that predates the surfacing).
   */
  binaryNotices?: BinaryMatchNoticeLike[] | null
}

/** Frozen v1 native surface (native/src/lib.rs + types.rs). */
export interface SearchNativeModule {
  grepSearch(options: GrepOptionsLike): Promise<GrepResultLike>
  findGlob(options: GlobOptionsLike): Promise<string[]>
  searchCancel(key?: string | null): void
  isNativeSearch(): boolean
}

/**
 * Structural validate probe for loadNativeModule. The frozen contract demands
 * the full native surface (grepSearch / findGlob / searchCancel plus the
 * isNativeSearch capability probe) — a module missing any of them is treated
 * as "no native" rather than accepted (guards against a stale/mismatched
 * .node payload masquerading as search-napi).
 */
export function isValidSearchNativeModule(mod: unknown): boolean {
  if (mod === null || typeof mod !== 'object') {
    return false
  }
  const m = mod as Record<string, unknown>
  return (
    typeof m.grepSearch === 'function' &&
    typeof m.findGlob === 'function' &&
    typeof m.searchCancel === 'function' &&
    typeof m.isNativeSearch === 'function'
  )
}

let cachedModule: SearchNativeModule | null = null
let loadAttempted = false

/**
 * Load the native search module. Returns null when unavailable or
 * structurally invalid — callers degrade to the rg subprocess path.
 */
export function loadSearchNative(): SearchNativeModule | null {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  // Module key 'search' matches the CI/vendor layout (vendor/search/<triple>/
  // search.node, stage & Sync derive both dir and file name from 'search')
  // and the compile.ts CRATES entry moduleName — EMBEDDED_NATIVES is keyed by
  // a single name, so loader key and on-disk file name must coincide.
  const mod = loadNativeModule<SearchNativeModule>(
    'search',
    'search',
    isValidSearchNativeModule,
  )
  cachedModule = mod
  return cachedModule
}

/**
 * One-shot hook: abortSignal → mod.searchCancel(cancelKey) (heart.rs
 * CancelRegistry payload). A per-call key scopes the kill to this session so
 * concurrent native searches never cross-cancel; legacy no-key callers fall
 * back to the process-wide generation counter. Returns a cleanup that
 * detaches the listener; the cancel side is idempotent, so firing it early
 * (already-aborted signal) is harmless.
 */
export function attachSearchCancel(
  mod: SearchNativeModule,
  signal: AbortSignal | undefined,
  cancelKey?: string | null,
): () => void {
  if (!signal) {
    return () => {}
  }
  const onCancel = () => {
    try {
      mod.searchCancel(cancelKey ?? null)
    } catch {
      // Engine already gone — nothing left to cancel.
    }
  }
  if (signal.aborted) {
    onCancel()
    return () => {}
  }
  signal.addEventListener('abort', onCancel, { once: true })
  return () => signal.removeEventListener('abort', onCancel)
}

export interface RenderGrepMatchesOptions {
  mode?: GrepOutputModeValue
  /** Show line numbers in content mode (rg -n). Default true. */
  showLineNumbers?: boolean
  /**
   * rg context semantics: `--` group separators are only emitted when
   * context lines were requested at all (rg ignores --context-separator
   * when printing matches without context).
   */
  context?: boolean
  /**
   * Count mode without the path prefix — `rg -c FILE` (single-file target)
   * prints a bare count, while a directory target prints `path:count`.
   */
  bareCount?: boolean
  /**
   * Native binary-quit surface (GrepResult.binaryNotices). Content mode
   * only: after a file's rendered lines, the official byte-format notice
   * `path\0binary file matches (found "\0" byte around offset N)` is
   * appended — rg prints it only for files that already produced output
   * lines (official uOn, _ALL.js:9463: `if(Ne && S.length > 0)`).
   */
  binaryNotices?: readonly BinaryMatchNoticeLike[] | null
}

/** Verbatim vendored rg 14.1.1 placeholder for max-columns-capped lines. */
const OMITTED_LONG_MATCHING_LINE = '[Omitted long matching line]'

function contextLine(
  path: string,
  lineNumber: number,
  text: string,
  withNumbers: boolean,
): string {
  return withNumbers ? `${path}-${lineNumber}-${text}` : `${path}-${text}`
}

/**
 * Render native matches into rg-subprocess-identical output lines.
 *
 * Concatenating the result must stay round-trip parseable by GrepTool's
 * splitContentLine: match lines keep the `path:NN:` shape the parser splits
 * on; context lines and `--` are passed through untouched by the parser —
 * exactly like the rg branch today (context lines keep their raw path; the
 * relativization map no-ops on them).
 */
export function renderGrepMatches(
  matches: readonly RenderableGrepMatch[],
  options: RenderGrepMatchesOptions = {},
): string {
  const mode = options.mode ?? 'Content'
  if (mode === 'Count') {
    return matches
      .map(m => (options.bareCount === true ? m.line : `${m.path}:${m.line}`))
      .join('\n')
  }
  if (mode === 'FilesWithMatches') {
    return matches.map(m => m.path).join('\n')
  }

  const withNumbers = options.showLineNumbers !== false
  const lines: string[] = []
  // Official uOn end-event notice queue (Content mode only, and only for
  // files that yield at least one rendered line, `S.length > 0`).
  const noticeByPath = new Map<string, number>()
  if (mode === 'Content') {
    for (const notice of options.binaryNotices ?? []) {
      if (
        notice &&
        typeof notice.path === 'string' &&
        typeof notice.offset === 'number'
      ) {
        // first-wins（FileCollector 只记首个 quit 偏移；官方 end 事件每文件
        // 一条 binary_offset）。
        if (!noticeByPath.has(notice.path)) {
          noticeByPath.set(notice.path, notice.offset)
        }
      }
    }
  }
  // rg prints the notice only for files that produced output lines
  // (official uOn `S.length > 0` guard, _ALL.js:9463).
  const flushNoticeForPath = (path: string | null, emittedLines: number) => {
    if (path === null || emittedLines === 0) return
    const offset = noticeByPath.get(path)
    if (offset !== undefined) {
      lines.push(
        `${path}\u0000binary file matches (found "\\0" byte around offset ${offset})`,
      )
    }
  }
  let prevPath: string | null = null
  let prevEndLine = 0
  let currentGroupLines = 0
  for (const match of matches) {
    const startLine = match.lineNumber - match.before.length
    const endLine = match.lineNumber + match.after.length
    // rg emits `--` before a group that is not contiguous with the previous
    // one: any other file, or a same-file gap (start beyond prevEnd + 1).
    // Unknown line numbers (0) count as a gap.
    if (
      options.context === true &&
      prevPath !== null &&
      (match.path !== prevPath || startLine <= 0 || startLine > prevEndLine + 1)
    ) {
      lines.push('--')
    }
    // Official parity: the notice rides AFTER the buffered output lines of
    // the file that hit the binary cutoff — the group boundary is the same
    // flush point (file change; a same-file gap would already imply the
    // searcher stopped at the NUL, so treat it as a boundary too).
    if (match.path !== prevPath) {
      flushNoticeForPath(prevPath, currentGroupLines)
      currentGroupLines = 0
    }
    for (let i = 0; i < match.before.length; i++) {
      lines.push(
        contextLine(
          match.path,
          startLine + i,
          match.before[i] ?? '',
          withNumbers,
        ),
      )
    }
    const text =
      match.truncated === true ? OMITTED_LONG_MATCHING_LINE : match.line
    lines.push(
      withNumbers
        ? `${match.path}:${match.lineNumber}:${text}`
        : `${match.path}:${text}`,
    )
    for (let i = 0; i < match.after.length; i++) {
      lines.push(
        contextLine(
          match.path,
          match.lineNumber + 1 + i,
          match.after[i] ?? '',
          withNumbers,
        ),
      )
    }
    prevPath = match.path
    prevEndLine = endLine
    currentGroupLines += match.before.length + 1 + match.after.length
  }
  flushNoticeForPath(prevPath, currentGroupLines)
  return lines.join('\n')
}
