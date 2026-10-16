import { randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, join, sep } from 'path'
import {
  attachSearchCancel,
  loadSearchNative,
} from '../../packages/search-napi/src/index'
import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import { getPlatform } from './platform.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from './permissions/filesystem.js'
import { getGlobExclusionsForPluginCache } from './plugins/orphanedPluginFilter.js'

/**
 * Expand a single top-level brace union into plain glob alternatives
 * ("*.{ts,tsx}" → ["*.ts", "*.tsx"]). The native pipeline's glob expression
 * grammar splits on commas/whitespace, so brace unions must be flattened
 * client-side (include-union semantics are identical). Returns null for
 * nested or unbalanced braces — those cannot be represented.
 */
export function expandTopLevelBraces(pattern: string): string[] | null {
  const openIndex = pattern.indexOf('{')
  if (openIndex === -1) {
    return pattern.includes(',') ? null : [pattern]
  }
  // Find the matching close brace, tracking nested opens.
  let depth = 0
  let closeIndex = -1
  for (let i = openIndex; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}') {
      depth--
      if (depth === 0) {
        closeIndex = i
        break
      }
    }
  }
  if (closeIndex === -1) return null
  const prefix = pattern.slice(0, openIndex)
  const body = pattern.slice(openIndex + 1, closeIndex)
  const suffix = pattern.slice(closeIndex + 1)
  const alternatives = body.split(',').filter(Boolean)
  if (alternatives.length === 0) return null
  const expanded: string[] = []
  for (const alternative of alternatives) {
    const piece = prefix + alternative + suffix
    const subExpanded = expandTopLevelBraces(piece)
    if (subExpanded === null) return null
    expanded.push(...subExpanded)
  }
  return expanded
}

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
  // The native globs only work with relative patterns
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  // SEARCH_NAPI native dispatch — the ONLY file-listing path (the rg --files
  // subprocess chain was retired wholesale). Semantics carried over from the
  // former rg invocation:
  //   include: the (brace-expanded) user pattern
  //   exclude: permission ignore rules + orphaned-plugin-cache dirs, as
  //            `!`-negated glob parts (native GlobFilter: exclude a dir =
  //            exclude its subtree, gitignore semantics)
  //   hidden / gitignore env knobs, mtime sort, offset+limit windowing.
  const mod = loadSearchNative()
  if (mod === null) {
    throw new Error('glob unavailable: native module missing')
  }
  if (abortSignal.aborted) {
    // rg treated a pre-started abort as a clean cancellation (empty set).
    return { files: [], truncated: false }
  }

  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    searchDir,
  )
  const pluginExclusions = await getGlobExclusionsForPluginCache(searchDir)

  // Compose the single glob expression the native side parses (comma/space
  // separated, `!`-negated). Brace unions are expanded client-side (see
  // expandTopLevelBraces) because the native split would shatter them
  // mid-alternative. A pattern that still contains a comma or whitespace
  // after expansion cannot round-trip and there is no subprocess fallback —
  // surface a precise error instead of a misleading one.
  const globParts = expandTopLevelBraces(searchPattern)
  if (globParts === null) {
    throw new Error(
      `unsupported glob pattern for native search: ${filePattern} (nested/unbalanced braces)`,
    )
  }
  for (const pattern of ignorePatterns) {
    globParts.push(pattern.startsWith('/') ? `!${pattern}` : `!**/${pattern}`)
  }
  for (const exclusion of pluginExclusions) {
    globParts.push(exclusion)
  }
  if (globParts.some(part => part.includes(',') || /\s/.test(part))) {
    throw new Error(
      `unsupported glob pattern for native search: ${filePattern} (cannot contain commas or whitespace)`,
    )
  }
  const globExpr = globParts.join(' ')

  // Note: use || instead of ?? to treat empty string as unset (defaulting to true)
  const noIgnore = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_NO_IGNORE || 'true')
  const hidden = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_HIDDEN || 'true')

  const cancelKey = randomUUID()
  const cancel = attachSearchCancel(mod, abortSignal, cancelKey)
  try {
    // maxResults carries a +1 sentinel: the native side applies the offset
    // itself, so `returned.length > limit` is exactly the old
    // `all.length > offset + limit` truncation predicate without
    // materializing the full (unbounded) file list.
    const found = await mod.findGlob({
      pattern: globExpr,
      path: searchDir,
      hidden, // retired rg path: --hidden (env CLAUDE_CODE_GLOB_HIDDEN)
      gitignore: !noIgnore, // retired rg path: --no-ignore when noIgnore
      sortByMtime: true, // retired rg path: --sort=modified
      maxResults: limit + 1,
      offset,
      timeoutMs: 20_000,
      // Per-call cancel key: abortSignal → searchCancel(key) kills ONLY
      // this session (heart.rs CancelRegistry — concurrent searches never
      // cross-cancel).
      cancelKey,
    })
    // Native walks absolute roots → absolute paths; keep the same
    // absolutization guard for relative cwd roots.
    const absolutePaths = found.map(p =>
      isAbsolute(p) ? p : join(searchDir, p),
    )
    return {
      files: absolutePaths.slice(0, limit),
      truncated: absolutePaths.length > limit,
    }
  } finally {
    cancel()
  }
}
