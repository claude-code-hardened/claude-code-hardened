import { homedir } from 'os'
import { dirname, isAbsolute, join, relative } from 'path'

/**
 * Pure path/pattern helpers for CdTool, mirroring the official 2.1.284 Cd
 * permission semantics (docs/reverse-284/full-source/_ALL.js:42543):
 *
 * - `globToRegex`  — port of the official `E()`: filePattern glob → RegExp
 *   (a leading double-star followed by a slash yields an optional directory
 *   tail, a slash followed by double-star yields an optional tail group, a
 *   lone star matches one path segment, double-star matches everything;
 *   case-insensitive, everything else escaped).
 * - `pathMatchesRule` — port of the official `B()` boundary check: the target
 *   is relativized against the rule's root (or, for relative patterns, the
 *   current session dir) and a match is REFUSED when the relativized path is
 *   `..` or starts with dot-dot-slash — i.e. a realpath that escapes the rule
 *   root never matches (blocked_by_rule / outsideAllowedPatterns upstream).
 */

export function globToRegex(pattern: string): RegExp {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (i === 0 && c === '*' && pattern[1] === '*' && pattern[2] === '/') {
      re += '(?:.*/)?'
      i += 2
    } else if (c === '/' && pattern[i + 1] === '*' && pattern[i + 2] === '*') {
      re += '(/.*)?'
      i += 2
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]+'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`${re}$`, 'i')
}

/**
 * Expand a leading `~` / `~/` to the user's home directory. Non-tilde paths
 * pass through untouched.
 */
export function expandTilde(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

/**
 * Split an absolute rule pattern into its static root directory and the
 * remaining relative glob. E.g. `/repo/src/**` → root `/repo/src`,
 * relativePattern `**`; `/etc` → root `/`, relativePattern `etc`.
 */
export function splitRootFromPattern(rawPattern: string): {
  root: string
  relativePattern: string
} {
  let pattern = rawPattern
  if (pattern === '~') pattern = homedir()
  else if (pattern.startsWith('~/')) pattern = join(homedir(), pattern.slice(2))
  if (!isAbsolute(pattern)) {
    // Relative patterns anchor at the caller-supplied base (session cwd),
    // handled by pathMatchesRule via the `base` parameter.
    return { root: '', relativePattern: pattern }
  }
  const globIdx = pattern.indexOf('*')
  const staticPart = (
    globIdx === -1 ? pattern : pattern.slice(0, globIdx)
  ).replace(/\/+$/, '')
  const root = staticPart === '' ? '/' : dirname(staticPart)
  const rest = pattern.slice(root.length).replace(/^\//, '')
  return { root, relativePattern: rest }
}

/**
 * Official `B()`: does `target` satisfy the `Cd` filePattern `ruleContent`?
 * `base` is the current session directory for root-less (relative) patterns.
 * A target whose relative path escapes the rule root (`..`, `../**`) never
 * matches — this is the realpath 越权 boundary.
 */
export function pathMatchesRule(
  pattern: string,
  target: string,
  base: string,
): boolean {
  const { root, relativePattern } = splitRootFromPattern(pattern)
  const anchor = root === '' ? base : root
  let rel: string
  try {
    rel = relative(anchor, target)
  } catch {
    return false
  }
  // Official: `if (u === '..' || u.startsWith('../')) return false`
  if (rel === '..' || rel.startsWith('../')) return false
  const cleaned = relativePattern
    .replace(/\/{2,}/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '')
  if (cleaned === '') return rel === ''
  return globToRegex(cleaned).test(rel)
}
