/**
 * Provides glob exclusion patterns for orphaned plugin versions.
 *
 * When plugin versions are updated, old versions are marked with a
 * `.orphaned_at` file but kept on disk for 7 days (since concurrent
 * sessions might still reference them). During this window, Grep/Glob
 * could return files from orphaned versions, causing Claude to use
 * outdated plugin code.
 *
 * We find `.orphaned_at` markers with a bounded (max-depth 4) fs walk and
 * generate `!**/<dir>/**` glob parts for their parent directories. The
 * cache is warmed in main.tsx AFTER cleanupOrphanedPluginVersionsInBackground
 * settles disk state. Once populated, the exclusion list is frozen for
 * the session unless /reload-plugins is called; subsequent disk mutations
 * (autoupdate, concurrent sessions) don't affect it.
 *
 * (The marker scan used to be a single `rg --files --max-depth 4 --glob
 * .orphaned_at` call; the rg subprocess chain was retired, and the native
 * walk cannot express max-depth — a bounded readdir walk reproduces the
 * exact semantics without native-module coupling.)
 */

import { readdir } from 'fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import { getPluginsDirectory } from './pluginDirectories.js'

// Inlined from cacheUtils.ts to avoid a circular dep through commands.js.
const ORPHANED_AT_FILENAME = '.orphaned_at'

/** Session-scoped cache. Frozen once computed — only cleared by explicit /reload-plugins. */
let cachedExclusions: string[] | null = null

/**
 * Find `.orphaned_at` markers up to maxDepth levels below root (rg
 * --max-depth semantics: entries directly in root are depth 1; recursion
 * stops at depth 4). Markers in dotfiles/hidden dirs are included (the
 * retired rg call passed --hidden) and ignore files are not consulted
 * (--no-ignore). Returns absolute marker paths.
 */
async function findOrphanedMarkers(root: string): Promise<string[]> {
  const markers: string[] = []

  // depth = levels below root; the marker sits at depth 4
  // (cache/<marketplace>/<plugin>/<version>/.orphaned_at).
  async function walk(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable subtree — best-effort scan, skip silently.
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isFile() && entry.name === ORPHANED_AT_FILENAME) {
        markers.push(fullPath)
        continue
      }
      if (entry.isDirectory() && depth < 4) {
        await walk(fullPath, depth + 1)
      }
    }
  }

  await walk(root, 1)
  return markers
}

/**
 * Get glob exclusion patterns for orphaned plugin versions.
 *
 * @param searchPath - When provided, exclusions are only returned if the
 *   search overlaps the plugin cache directory (avoids unnecessary `!` glob
 *   args for searches outside the cache).
 *
 * Warmed eagerly in main.tsx after orphan GC; the lazy-compute path here
 * is a fallback. Best-effort: returns empty array if anything goes wrong.
 */
export async function getGlobExclusionsForPluginCache(
  searchPath?: string,
): Promise<string[]> {
  const cachePath = normalize(join(getPluginsDirectory(), 'cache'))

  if (searchPath && !pathsOverlap(searchPath, cachePath)) {
    return []
  }

  if (cachedExclusions !== null) {
    return cachedExclusions
  }

  try {
    // Find all .orphaned_at files within the plugin cache directory.
    // --hidden: marker is a dotfile. --no-ignore: don't let a stray
    // .gitignore hide it. --max-depth 4: marker is always at
    // cache/<marketplace>/<plugin>/<version>/.orphaned_at — don't recurse
    // into plugin contents (node_modules, etc.). Never-aborts signal: no
    // caller signal to thread.
    const markers = await findOrphanedMarkers(cachePath)

    cachedExclusions = markers.map(markerPath => {
      // rg may return absolute or relative — normalize to relative.
      const versionDir = dirname(markerPath)
      const rel = isAbsolute(versionDir)
        ? relative(cachePath, versionDir)
        : versionDir
      // Glob patterns always use forward slashes, even on Windows
      const posixRelative = rel.replace(/\\/g, '/')
      return `!**/${posixRelative}/**`
    })
    return cachedExclusions
  } catch {
    // Best-effort — don't break core search tools if the walk fails here
    cachedExclusions = []
    return cachedExclusions
  }
}

export function clearPluginCacheExclusions(): void {
  cachedExclusions = null
}

/**
 * One path is a prefix of the other. Special-cases root (normalize('/') + sep
 * = '//'). Case-insensitive on win32 since normalize() doesn't lowercase
 * drive letters and CLAUDE_CODE_PLUGIN_CACHE_DIR may disagree with resolved.
 */
function pathsOverlap(a: string, b: string): boolean {
  const na = normalizeForCompare(a)
  const nb = normalizeForCompare(b)
  return (
    na === nb ||
    na === sep ||
    nb === sep ||
    na.startsWith(nb + sep) ||
    nb.startsWith(na + sep)
  )
}

function normalizeForCompare(p: string): string {
  const n = normalize(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}
