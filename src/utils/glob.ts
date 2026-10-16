import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, join, sep } from 'path'
import {
  attachSearchCancel,
  loadSearchNative,
} from '../../packages/search-napi/src/index'
import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { getGlobExclusionsForPluginCache } from './plugins/orphanedPluginFilter.js'
import { ripGrep } from './ripgrep.js'

/**
 * Extracts the static base directory from a glob pattern.
 * The base directory is everything before the first glob special character (* ? [ {).
 * Returns the directory portion and the remaining relative pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  // Find the first glob special character: *, ?, [, {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // No glob characters - this is a literal path
    // Return the directory portion and filename as pattern
    const dir = dirname(pattern)
    const file = basename(pattern)
    return { baseDir: dir, relativePattern: file }
  }

  // Get everything before the first glob character
  const staticPrefix = pattern.slice(0, match.index)

  // Find the last path separator in the static prefix
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // No path separator before the glob - pattern is relative to cwd
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on Windows)
  // When lastSepIndex is 0, baseDir is empty but we need to use '/' as the root
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/'
  }

  // Handle Windows drive root paths (e.g., C:/*.txt)
  // 'C:' means "current directory on drive C" (relative), not root
  // We need 'C:/' or 'C:\' for the actual drive root
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + sep
  }

  return { baseDir, relativePattern }
}

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ files: string[]; truncated: boolean }> {
  let searchDir = cwd
  let searchPattern = filePattern

  // Handle absolute paths by extracting the base directory and converting to relative pattern
  // ripgrep's --glob flag only works with relative patterns
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    searchDir,
  )

  // Use ripgrep for better memory performance
  // --files: list files instead of searching content
  // --glob: filter by pattern
  // --sort=modified: sort by modification time (oldest first)
  // --no-ignore: don't respect .gitignore (default true, set CLAUDE_CODE_GLOB_NO_IGNORE=false to respect .gitignore)
  // --hidden: include hidden files (default true, set CLAUDE_CODE_GLOB_HIDDEN=false to exclude)
  // Note: use || instead of ?? to treat empty string as unset (defaulting to true)
  const noIgnore = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_NO_IGNORE || 'true')
  const hidden = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_HIDDEN || 'true')
  const args = [
    '--files',
    '--glob',
    searchPattern,
    '--sort=modified',
    ...(noIgnore ? ['--no-ignore'] : []),
    ...(hidden ? ['--hidden'] : []),
  ]

  // Add ignore patterns
  for (const pattern of ignorePatterns) {
    args.push('--glob', `!${pattern}`)
  }

  // Exclude orphaned plugin version directories
  const pluginExclusions = await getGlobExclusionsForPluginCache(searchDir)
  for (const exclusion of pluginExclusions) {
    args.push('--glob', exclusion)
  }

  // SEARCH_NAPI native-first dispatch (flag-gated — zero impact while off).
  // The frozen GlobOptions carries a single include pattern and no negative
  // glob list, so only dispatch when nothing needs excluding (permission
  // ignore rules / orphaned plugin cache) — otherwise the rg branch below
  // keeps byte-perfect fidelity. Any native failure also falls through.
  if (feature('SEARCH_NAPI')) {
    const mod = loadSearchNative()
    if (
      mod !== null &&
      ignorePatterns.length === 0 &&
      pluginExclusions.length === 0 &&
      !abortSignal.aborted
    ) {
      const cancelKey = crypto.randomUUID()
      const cancel = attachSearchCancel(mod, abortSignal, cancelKey)
      try {
        // maxResults carries a +1 sentinel: the native side applies the
        // offset itself, so `returned.length > limit` is exactly today's
        // `all.length > offset + limit` truncation predicate without
        // materializing the full (unbounded) file list.
        const found = await mod.findGlob({
          pattern: searchPattern,
          path: searchDir,
          hidden, // rg path: --hidden (env CLAUDE_CODE_GLOB_HIDDEN)
          gitignore: !noIgnore, // rg path: --no-ignore when noIgnore
          sortByMtime: true, // rg path: --sort=modified
          maxResults: limit + 1,
          offset,
          timeoutMs: 20_000,
          // Per-call cancel key: abortSignal → searchCancel(key) kills ONLY
          // this session (heart.rs CancelRegistry — concurrent searches never
          // cross-cancel).
          cancelKey,
        })
        // Native walks absolute roots → absolute paths; keep the same
        // absolutization guard as the rg branch for relative cwd roots.
        const absolutePaths = found.map(p =>
          isAbsolute(p) ? p : join(searchDir, p),
        )
        return {
          files: absolutePaths.slice(0, limit),
          truncated: absolutePaths.length > limit,
        }
      } catch {
        // Native engine failure (missing artifact, bad glob) → rg path below.
      } finally {
        cancel()
      }
    }
  }

  const allPaths = await ripGrep(args, searchDir, abortSignal)

  // ripgrep returns relative paths, convert to absolute
  const absolutePaths = allPaths.map(p =>
    isAbsolute(p) ? p : join(searchDir, p),
  )

  const truncated = absolutePaths.length > offset + limit
  const files = absolutePaths.slice(offset, offset + limit)

  return { files, truncated }
}
