/**
 * Storage layer shared by the memory_write / memory_list / memory_read trio.
 *
 * The trio writes to the SAME root as LocalMemoryRecall's multiStore backend
 * (`$CLAUDE_CONFIG_DIR/local-memory/<store>/`), so documents saved here are
 * directly recallable via LocalMemoryRecall (same-root read/write contract).
 *
 * Project scope: when no store is given, the default store is derived from the
 * project directory (`CLAUDE_PROJECT_DIR` ?? cwd), giving each project its own
 * namespace inside the shared root.
 *
 * Document format: markdown with a YAML-ish frontmatter block carrying
 * `name`, `description` and `type` metadata, followed by the body:
 *
 *   ---
 *   name: payments-retry-logic
 *   description: How payment retries are scheduled
 *   type: project
 *   ---
 *   <markdown body>
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  closeSync,
  realpathSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MAX_LIST_MEMORY_DOCS } from './constants.js'

export const MEMORY_DOC_EXT = '.md'

// Same shape as LocalMemoryRecall's STORE_REGEX_STRING: no leading dot,
// no path separators / colon / null, 1..255 chars. Built from a string so
// biome's noControlCharactersInRegex does not fire on the \x00 escape.
const STORE_REGEX_STRING = '^(?!\\.)[^/\\\\:\\x00]{1,255}$'
const STORE_REGEX = new RegExp(STORE_REGEX_STRING)

export function isValidMemoryStoreName(store: string): boolean {
  return typeof store === 'string' && STORE_REGEX.test(store)
}

// ── Store allowlist（官方 connected-store 面）───────────────────────────────

/**
 * Session-available store set, official 2.8.4 对位（reverse-284 _ALL.js:5230
 * `Eit({storeId:e,write:n=!1})`）：store 必须属于本会话已连接的 store 集，
 * 未连接的 id 一律 `refused/unknown_store`（"No memory store with id X is
 * available in this session. Available stores: …"）。CCH 的"已连接集" =
 * `getMemoryBaseDir()` 下实际存在的 store 目录（同根，LocalMemoryRecall /
 * multiStore 写入的都算）∪ 当前 cwd 项目默认 store（尚未落盘时允许创建）。
 *
 * 写入面进一步收紧（官方 `n && !a.writable` → refused/read_only，2.8.4 的
 * 会话 store 对 memory_write 是只读的；CCH 设计保留写入 = 超出官方的扩展，
 * 仅放开当前项目默认 store 这一个可写面，其余共享/project-* store 拒写）：
 * 仅默认 store 可写。报告口径：write 面为 CCH 扩展，permission 门 +
 * 102400 上限对位官方。
 */
export function getAvailableMemoryStores(): string[] {
  const available = new Set<string>()
  const baseDir = getMemoryBaseDir()
  try {
    for (const dirent of readdirSync(baseDir, { withFileTypes: true })) {
      if (dirent.isDirectory() && !dirent.name.endsWith('.archived')) {
        available.add(dirent.name)
      }
    }
  } catch {
    // Root not created yet — only the default store is available then.
  }
  available.add(getDefaultStoreName())
  return [...available].sort()
}

/**
 * Resolve a requested store against the allowlist. Returns the effective
 * store name (default when omitted) or a refusal message mirroring the
 * official unknown_store wording.
 */
export function resolveStoreAccess(store: string | undefined): {
  store: string
  error?: string
} {
  const effective = store ?? getDefaultStoreName()
  const available = getAvailableMemoryStores()
  if (!available.includes(effective)) {
    return {
      store: effective,
      error: `No memory store "${effective}" is available in this session. Available stores: ${available.join(', ')}.`,
    }
  }
  return { store: effective }
}

/**
 * Writable-store gate (official read_only 面，收紧为唯一可写 = 项目默认
 * store；跨项目 project-* / 共享 store 的写入一律拒绝)。
 */
export function checkStoreWritable(store: string): string | undefined {
  const writable = getDefaultStoreName()
  if (store === writable) return undefined
  return `The memory store "${store}" is read-only in this session; changes will not persist. Writable stores: ${writable}.`
}

// ── Root resolution ───────────────────────────────────────────────────────────

let _baseDirCache: { configDir: string; baseDir: string } | undefined

/**
 * Root shared with multiStore's base dir: `$CLAUDE_CONFIG_DIR/local-memory`.
 * Cached per config dir so tests that change CLAUDE_CONFIG_DIR mid-process
 * pick up the new root (same pattern as multiStore.getBaseDir).
 */
export function getMemoryBaseDir(): string {
  const configDir =
    process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  if (_baseDirCache && _baseDirCache.configDir === configDir) {
    return _baseDirCache.baseDir
  }
  const baseDir = join(configDir, 'local-memory')
  _baseDirCache = { configDir, baseDir }
  return baseDir
}

/**
 * Default (project-scoped) store name derived from the project directory.
 * `project-<sanitized-basename>` — passes isValidMemoryStoreName by
 * construction: the `project-` prefix prevents a leading dot, and all
 * characters outside [A-Za-z0-9._-] are collapsed to '_'.
 */
export function getDefaultStoreName(): string {
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd()
  const segment = basename(projectDir)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
  return segment.length > 0 ? `project-${segment}` : 'project-default'
}

// ── Entry path resolution ─────────────────────────────────────────────────────

export interface ResolvedEntry {
  storeDir: string
  target: string
}

/**
 * Resolve a store + relative doc path to an absolute path inside the memory
 * root, hard-refusing anything that could escape it:
 *   - non-.md paths, absolute paths, backslashes, null bytes
 *   - empty, "." / ".." or hidden path segments, >8 nesting levels
 *   - symlink escape: after resolving, both the target and (when creating)
 *     the deepest existing parent are realpath-checked for containment in
 *     the realpath'd store dir.
 * With `create: true` the store dir and intermediate doc directories are
 * created; otherwise a missing store throws.
 */
export function resolveMemoryEntryPath(
  store: string,
  relPath: string,
  opts: { create?: boolean } = {},
): ResolvedEntry {
  if (typeof store !== 'string' || !isValidMemoryStoreName(store)) {
    throw new Error(`Invalid memory store name: ${JSON.stringify(store)}`)
  }
  if (
    typeof relPath !== 'string' ||
    relPath.length === 0 ||
    !relPath.endsWith(MEMORY_DOC_EXT)
  ) {
    throw new Error(
      `Memory document path must end with "${MEMORY_DOC_EXT}": ${JSON.stringify(relPath)}`,
    )
  }
  if (isAbsolute(relPath) || relPath.includes('\\')) {
    throw new Error(
      `Memory document path must be relative and use "/" separators: ${relPath}`,
    )
  }
  if (relPath.includes('\0')) {
    throw new Error('Memory document path must not contain null bytes.')
  }
  const segments = relPath.split('/')
  if (
    segments.some(
      s => s.length === 0 || s === '.' || s === '..' || s.startsWith('.'),
    ) ||
    segments.length > 8
  ) {
    throw new Error(
      `Memory document path must not contain empty, "." / ".." or hidden segments (max 8 levels): ${relPath}`,
    )
  }

  const storeDir = join(getMemoryBaseDir(), store)
  if (!existsSync(storeDir)) {
    if (!opts.create) {
      throw new Error(`Memory store "${store}" not found.`)
    }
    mkdirSync(storeDir, { recursive: true })
  }
  const realStoreDir = realpathSync(storeDir)

  // Defense in depth: path segments are pre-validated (no ".." etc.), so
  // resolve() cannot walk out — the containment check guards against
  // unexpected separators / future edits.
  const target = resolve(realStoreDir, ...segments)
  if (!target.startsWith(realStoreDir + sep)) {
    throw new Error(
      `Refusing to access path outside memory store "${store}": ${relPath}`,
    )
  }

  if (existsSync(target)) {
    // Existing file (possibly reached through a symlinked directory):
    // the real target must stay inside the real store dir.
    const realTarget = realpathSync(target)
    if (realTarget !== target && !realTarget.startsWith(realStoreDir + sep)) {
      throw new Error(
        `Refusing to access symlinked path outside memory store "${store}": ${relPath}`,
      )
    }
    return { storeDir: realStoreDir, target }
  }

  if (!opts.create) {
    return { storeDir: realStoreDir, target }
  }

  // Creating: make sure intermediate directories exist and are not symlinks
  // pointing outside the store.
  const parentDir = resolve(realStoreDir, ...segments.slice(0, -1))
  mkdirSync(parentDir, { recursive: true })
  const realParent = realpathSync(parentDir)
  // 单段相对路径（无子目录）时 parentDir === realStoreDir：此时 parent 就是
  // store 根本身，属于合法包容（原实现要求 realParent 必须带分隔符前缀，
  // 导致 store 根直下的文档一律被误判为越界）。
  const parentContained =
    realParent === realStoreDir || realParent.startsWith(realStoreDir + sep)
  if (!parentContained) {
    throw new Error(
      `Refusing to create directories outside memory store "${store}": ${relPath}`,
    )
  }
  return {
    storeDir: realStoreDir,
    target: resolve(realParent, basename(target)),
  }
}

// ── Frontmatter handling ──────────────────────────────────────────────────────

export interface MemoryDocMeta {
  name: string
  description?: string
  type: string
}

export function serializeMemoryDoc(meta: MemoryDocMeta, body: string): string {
  const lines = ['---', `name: ${meta.name}`]
  if (meta.description) lines.push(`description: ${meta.description}`)
  lines.push(`type: ${meta.type}`, '---', '', body)
  return lines.join('\n')
}

/** Minimal frontmatter parser: `---\nkey: value\n...\n---\n<body>`. */
export function parseMemoryDoc(raw: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: normalized }
  }
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) {
    return { frontmatter: {}, body: normalized }
  }
  const frontmatter: Record<string, string> = {}
  for (const line of normalized.slice(4, end).split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  const body = normalized.slice(end + '\n---\n'.length).replace(/^\n+/, '')
  return { frontmatter, body }
}

// ── Bounded IO ────────────────────────────────────────────────────────────────

const READ_SLACK_BYTES = 16

/**
 * Bounded read: never loads more than `maxBytes + READ_SLACK_BYTES` of a doc
 * into memory (mirrors multiStore.getEntryBounded). Returns null if the file
 * does not exist.
 */
export function readMemoryDocBounded(
  target: string,
  maxBytes: number,
): { value: string; truncated: boolean } | null {
  let stat
  try {
    stat = statSync(target)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  const want = Math.min(stat.size, maxBytes + READ_SLACK_BYTES)
  const buf = Buffer.alloc(want)
  let read = 0
  if (want > 0) {
    const fd = openSync(target, 'r')
    try {
      read = readSync(fd, buf, 0, want, 0)
    } finally {
      closeSync(fd)
    }
  }
  // On-disk file larger than what we read → truncated regardless of codec.
  const fileTruncated = stat.size > maxBytes
  let value = buf.subarray(0, read).toString('utf8')
  let codecTruncated = false
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    const trimmed = truncateUtf8(value, maxBytes)
    value = trimmed.value
    codecTruncated = trimmed.truncated
  }
  return { value, truncated: fileTruncated || codecTruncated }
}

/** O(n) UTF-8 truncation at a codepoint boundary (same approach as recall). */
export function truncateUtf8(
  s: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return { value: s, truncated: false }
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return { value: buf.subarray(0, end).toString('utf8'), truncated: true }
}

// ── Listing ───────────────────────────────────────────────────────────────────

export interface ListedMemoryDoc {
  path: string
  name: string
  description?: string
  type: string
}

/**
 * Recursively list memory docs under a store dir, bounded to
 * MAX_LIST_MEMORY_DOCS files. Dotfiles / non-.md files (e.g. `.tmp` spill
 * files from atomic writes) are skipped. Returns null if the store does not
 * exist.
 */
export function listMemoryDocs(store: string): {
  docs: ListedMemoryDoc[]
  truncated: boolean
} | null {
  const storeDir = join(getMemoryBaseDir(), store)
  if (!existsSync(storeDir)) return null
  const realStoreDir = realpathSync(storeDir)

  const docs: ListedMemoryDoc[] = []
  let truncated = false

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (truncated || depth > 8) return
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const dirent of dirents) {
      if (docs.length >= MAX_LIST_MEMORY_DOCS) {
        truncated = true
        return
      }
      const name = dirent.name
      const rel = prefix.length > 0 ? `${prefix}/${name}` : name
      if (dirent.isDirectory()) {
        walk(join(dir, name), rel, depth + 1)
        continue
      }
      if (!dirent.isFile() || !name.endsWith(MEMORY_DOC_EXT)) continue
      if (name.startsWith('.')) continue
      let raw = ''
      try {
        raw = readFileSync(join(dir, name), 'utf8')
      } catch {
        continue
      }
      const { frontmatter } = parseMemoryDoc(raw)
      const stem = name.slice(0, -MEMORY_DOC_EXT.length)
      const doc: ListedMemoryDoc = {
        path: rel,
        name: frontmatter['name'] || stem,
        type: frontmatter['type'] || 'general',
      }
      const description = frontmatter['description']
      if (description) doc.description = description
      docs.push(doc)
    }
  }

  walk(realStoreDir, '', 0)
  return { docs, truncated }
}

// ── Atomic write helper ───────────────────────────────────────────────────────

/**
 * Atomic write (tmp file + rename, mirroring multiStore setEntry) so a crash
 * mid-write never leaves a half-written document behind.
 */
export function writeFileAtomic(target: string, contents: string): void {
  const tmpPath = join(
    target.slice(0, target.lastIndexOf(sep) + 1),
    `.${randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(tmpPath, contents, 'utf8')
    // POSIX rename(2) is atomic — no reader ever sees a partial doc.
    renameSync(tmpPath, target)
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      /* ignore cleanup error */
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to write memory document ${target}: ${message}`)
  }
}
