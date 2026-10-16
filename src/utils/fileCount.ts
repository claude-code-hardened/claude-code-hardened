import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import * as path from 'path'
import { loadSearchNative } from '../../packages/search-napi/src/index'
import { logError } from './log.js'

// Heuristic repo-size probe for telemetry (project_file_count_rounded).
// The retired rg implementation streamed `rg --files | wc -l`; the native
// walk materializes up to the cap below — still bounded by the short
// timeout, and every failure path degrades to undefined (best-effort).
const MAX_PROBE = 1_000_000

/**
 * Count files in a directory recursively via the native search walk and
 * round to the nearest power of 10 for privacy.
 *
 * The native walk ("find every file") is far more efficient than native
 * Node.js recursion for large directories — the BFS walkpruner skips
 * .gitignore'd trees exactly like the retired `rg --files` did.
 *
 * @param dirPath Directory path to count files in
 * @param abortSignal AbortSignal to cancel the operation
 * @param ignorePatterns Optional additional patterns to ignore (beyond .gitignore)
 * @returns Approximate file count rounded to the nearest power of 10
 */
export const countFilesRounded = memoize(
  async (
    dirPath: string,
    abortSignal: AbortSignal,
    ignorePatterns: string[] = [],
  ): Promise<number | undefined> => {
    // Skip file counting if we're in the home directory to avoid triggering
    // macOS TCC permission dialogs for Desktop, Downloads, Documents, etc.
    if (path.resolve(dirPath) === path.resolve(homedir())) {
      return undefined
    }

    try {
      const mod = loadSearchNative()
      if (mod === null) {
        return undefined
      }
      // Compose the rg --glob face from the old implementation: positive
      // patterns would shrink the count, so everything arrives negated.
      const globParts = ignorePatterns.map(pattern =>
        pattern.startsWith('/') ? `!${pattern}` : `!**/${pattern}`,
      )
      const count = (
        await mod.findGlob({
          pattern: globParts.join(' ') || undefined,
          path: dirPath,
          hidden: true, // retired rg path: --hidden
          gitignore: true, // retired rg path: respects .gitignore
          maxResults: MAX_PROBE,
          timeoutMs: 1_000,
          // Fires searchCancel(key) when abortSignal fires — a cancelled
          // walk throws/rejects and the catch below returns undefined,
          // exactly like the retired AbortSignal.timeout rg behavior.
          cancelKey: 'file-count',
        })
      ).length

      // Round to nearest power of 10 for privacy
      if (count === 0) return 0

      const magnitude = Math.floor(Math.log10(count))
      const power = 10 ** magnitude

      // Round to nearest power of 10
      // e.g., 8 -> 10, 42 -> 100, 350 -> 100, 750 -> 1000
      return Math.round(count / power) * power
    } catch (error) {
      // Timeout/abort firing is expected on large/slow repos, not an error.
      if ((error as Error)?.name !== 'AbortError') logError(error)
    }
  },
  // lodash memoize's default resolver only uses the first argument.
  // ignorePatterns affect the result, so include them in the cache key.
  // abortSignal is intentionally excluded — it doesn't affect the count.
  (dirPath, _abortSignal, ignorePatterns = []) =>
    `${dirPath}|${ignorePatterns.join(',')}`,
)
