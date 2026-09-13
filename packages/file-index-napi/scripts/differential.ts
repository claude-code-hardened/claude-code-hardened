#!/usr/bin/env bun
/**
 * Differential test: TS FileIndex (src/native-ts/file-index/index.ts — the
 * behavioral baseline) vs the Rust file-index native module.
 *
 * The TS implementation is imported DIRECTLY (source of truth, zero drift);
 * the native module is loaded from a .node artifact path. Every query in the
 * battery must produce identical results (path order + exact double scores)
 * on both implementations, over:
 *   1. real repo paths (walked from the CWD), synchronous build,
 *   2. chunked appendPaths + TS loadFromFileListAsync (the async-build path),
 *   3. a 270k-path synthetic corpus (differential + benchmark at scale).
 *
 * Zero npm dependencies. Exit 0 = 100% match; any mismatch prints details
 * and exits 1.
 *
 * Usage:
 *   bun run packages/file-index-napi/scripts/differential.ts \
 *     <file-index.node> [file-or-dir...]
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { FileIndex as TsFileIndex } from '../../../src/native-ts/file-index/index'

const nodePath = process.argv[2]
if (!nodePath || !existsSync(nodePath)) {
  console.error('usage: differential.ts <file-index.node> [paths...]')
  process.exit(2)
}
const nodeRequire = createRequire(import.meta.url)
const napi = nodeRequire(nodePath)

type SearchResult = { path: string; score: number }
type Searcher = {
  search(query: string, limit: number): SearchResult[]
}

// ---------------------------------------------------------------------------
// Path collection
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'coverage',
])

function collect(p: string, root: string, out: string[]): void {
  let st: import('node:fs').Stats
  try {
    st = statSync(p)
  } catch {
    return // broken symlink / vanished file — skip
  }
  if (st.isDirectory()) {
    const base = p.split(sep).pop() ?? ''
    if (SKIP_DIRS.has(base)) return
    for (const e of readdirSync(p)) collect(join(p, e), root, out)
  } else if (st.isFile()) {
    out.push(relative(root, p).split(sep).join('/'))
  }
}

// Deterministic LCG so every run compares identical corpora.
let seed = 0x9e3779b9 >>> 0
function rnd(n: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % n
}

const TARGET_SCALE = 270_000

/** Pad real paths to ~270k with a realistic synthetic mix: nesting, CJK and
 * space-containing dirs, uppercase, dots/dashes/underscores, Windows-style
 * separators, plus duplicates and empty strings to exercise dedupe. */
function expandToScale(base: string[], target: number): string[] {
  const out = base.slice()
  const dirs = [
    'src',
    'pkg',
    '模块',
    'Test Suite',
    'UPPER',
    'deep',
    'a.b',
    'x_y',
    'with space',
    'test',
    'components',
    'utils',
  ]
  const exts = [
    '.ts',
    '.tsx',
    '.rs',
    '.json',
    '.md',
    '.toml',
    '.txt',
    '.spec.ts',
    '.test.ts',
  ]
  const stems = [
    'index',
    'main',
    'mod',
    'lib',
    'util',
    'helper',
    'config',
    '组件',
    '类型',
    'Handler',
    'Service',
    'file-index',
  ]
  let i = 0
  while (out.length < target) {
    const dir = dirs[rnd(dirs.length)]!
    const stem = stems[rnd(stems.length)]!
    const ext = exts[rnd(exts.length)]!
    const parts = [`${dir}${rnd(97)}`]
    const depth = rnd(3)
    for (let d = 0; d < depth; d++) parts.push(`${dir}-${d}`)
    parts.push(`${stem}_${i}${ext}`)
    let p = parts.join(rnd(8) === 0 ? '\\' : '/')
    if (rnd(20) === 0) p = `@scoped/${p}`
    out.push(p)
    if (rnd(50) === 0) out.push(p) // duplicate → dedupe parity
    if (rnd(500) === 0) out.push('') // empty line → filtered parity
    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// Query battery — empty, 1-char, prefixes, camelCase, uppercase (smart-case),
// CJK, spaces, separators, no-match, >64 chars.
// ---------------------------------------------------------------------------
const QUERIES = [
  '',
  's',
  'sr',
  'src',
  'src/',
  'index',
  'ind',
  'test',
  'Test',
  'TEST',
  'file',
  'file-index',
  'fileIndex',
  'FileIndex',
  'File_Index',
  'README',
  'readme',
  'napi',
  'rust',
  'native',
  'a',
  'a b',
  'lib.rs',
  'Cargo',
  'cargo',
  'tok',
  'token-counter',
  'differential',
  '中文',
  '组件',
  '类型',
  'SRC',
  'LIB',
  'PAckage.json',
  'package-json',
  'app',
  'components',
  'useTypeahead',
  'use_typeahead',
  'x.ts',
  '2024',
  'agent-tools',
  '@scoped',
  'TEST SUITE',
  'zzz-no-match-xyz',
  'İ',
  'é',
  'a'.repeat(70),
]

let failures = 0
let checks = 0

function compareOnce(
  label: string,
  ts: Searcher,
  rs: Searcher,
  query: string,
  limit: number,
): void {
  checks++
  let tsResults: SearchResult[]
  let rsResults: SearchResult[]
  try {
    tsResults = ts.search(query, limit)
  } catch (e) {
    failures++
    console.log(
      `MISMATCH [${label}] ts threw on "${query}": ${(e as Error).message}`,
    )
    return
  }
  try {
    rsResults = rs.search(query, limit)
  } catch (e) {
    failures++
    console.log(
      `MISMATCH [${label}] native threw on "${query}": ${(e as Error).message}`,
    )
    return
  }
  if (tsResults.length !== rsResults.length) {
    failures++
    console.log(
      `MISMATCH [${label}] "${query}" limit=${limit}: length ts=${tsResults.length} native=${rsResults.length}`,
    )
    return
  }
  for (let i = 0; i < tsResults.length; i++) {
    const a = tsResults[i]!
    const b = rsResults[i]!
    if (a.path !== b.path) {
      failures++
      console.log(
        `MISMATCH [${label}] "${query}" limit=${limit} #${i}: path ts="${a.path}" native="${b.path}"`,
      )
      return
    }
    if (a.score !== b.score) {
      failures++
      console.log(
        `MISMATCH [${label}] "${query}" limit=${limit} #${i}: score ts=${a.score} native=${b.score} (${a.path})`,
      )
      return
    }
  }
}

function runPhase(
  label: string,
  ts: Searcher,
  rs: Searcher,
  queries: string[],
  limits: number[],
): void {
  const phaseStart = failures
  for (const q of queries) {
    for (const limit of limits) {
      compareOnce(label, ts, rs, q, limit)
    }
  }
  const count = queries.length * limits.length
  console.log(
    `[${label}] ${count - (failures - phaseStart)}/${count} query×limit checks match`,
  )
}

// ---------------------------------------------------------------------------
// Phase 1: real paths, synchronous build
// ---------------------------------------------------------------------------
const root = process.cwd()
const realPaths: string[] = []
collect(root, root, realPaths)
console.log(
  `collected ${realPaths.length} real paths from ${root} (unique ${new Set(realPaths).size})`,
)

const tsSync = new TsFileIndex()
tsSync.loadFromFileList(realPaths)
const nativeSync = napi.createNativeFileIndex()
nativeSync.loadFromFileList(realPaths)

const uniqueCount = new Set(realPaths.filter(p => p.length > 0)).size
checks++
if (nativeSync.pathCount() !== uniqueCount) {
  failures++
  console.log(
    `MISMATCH pathCount: native=${nativeSync.pathCount()} expected ${uniqueCount}`,
  )
}
runPhase('sync-build', tsSync, nativeSync, QUERIES, [0, 1, 5, 15, 50])

// ---------------------------------------------------------------------------
// Phase 2: async build on both sides + chunked native append (odd chunk size)
// ---------------------------------------------------------------------------
const tsAsync = new TsFileIndex()
{
  const { done } = tsAsync.loadFromFileListAsync(realPaths)
  await done
}
const nativeChunked = napi.createNativeFileIndex()
for (let i = 0; i < realPaths.length; i += 997) {
  nativeChunked.appendPaths(realPaths.slice(i, i + 997))
}
runPhase('async-build', tsAsync, nativeChunked, QUERIES, [15])
// TS sync vs TS async must also agree (baseline self-consistency).
runPhase('ts-sync-vs-async', tsSync, tsAsync, QUERIES, [15])

// ---------------------------------------------------------------------------
// Phase 3: 270k scale — differential + benchmark
// ---------------------------------------------------------------------------
console.log(`\nexpanding corpus to ${TARGET_SCALE} paths...`)
const bigPaths = expandToScale(realPaths, TARGET_SCALE)
console.log(`corpus: ${bigPaths.length} entries`)

let t0 = performance.now()
const tsBig = new TsFileIndex()
tsBig.loadFromFileList(bigPaths)
const tsBuildMs = performance.now() - t0

t0 = performance.now()
const nativeBig = napi.createNativeFileIndex()
nativeBig.loadFromFileList(bigPaths)
const nativeBuildMs = performance.now() - t0

runPhase('scale-270k', tsBig, nativeBig, QUERIES, [15])

// Benchmark: per-query timings at production limit (15).
let tsTotalMs = 0
let nativeTotalMs = 0
let worstNativeMs = 0
let worstQuery = ''
const benchQueries = QUERIES.filter(q => q.length > 0)
for (const q of benchQueries) {
  const a0 = performance.now()
  tsBig.search(q, 15)
  const aMs = performance.now() - a0
  const b0 = performance.now()
  nativeBig.search(q, 15)
  const bMs = performance.now() - b0
  tsTotalMs += aMs
  nativeTotalMs += bMs
  if (bMs > worstNativeMs) {
    worstNativeMs = bMs
    worstQuery = q.length > 20 ? `${q.slice(0, 17)}...` : q
  }
}
const n = benchQueries.length
console.log(`\nbenchmark (${bigPaths.length} paths, ${n} queries):`)
console.log(
  `  build    ts=${tsBuildMs.toFixed(0)}ms  native=${nativeBuildMs.toFixed(0)}ms`,
)
console.log(
  `  search   ts avg=${(tsTotalMs / n).toFixed(2)}ms  native avg=${(nativeTotalMs / n).toFixed(2)}ms  (${(tsTotalMs / Math.max(nativeTotalMs, 0.001)).toFixed(1)}x)`,
)
console.log(
  `  native worst=${worstNativeMs.toFixed(2)}ms ("${worstQuery}") — target <1ms`,
)

console.log(
  `\ndifferential: ${checks - failures}/${checks} checks match` +
    `${failures === 0 ? '' : `, ${failures} FAILED`}`,
)
process.exit(failures === 0 ? 0 : 1)
