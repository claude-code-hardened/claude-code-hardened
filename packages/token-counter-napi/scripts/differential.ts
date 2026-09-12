/**
 * Differential test: native token-counter .node vs an independent JS
 * re-implementation of the cl100k_base BPE (translated line-by-line from
 * tiktoken-rs 0.6.0 vendor_tiktoken.rs).
 *
 * Zero-dependency, runs under node or bun:
 *   node differential.ts [path/to/token-counter.node]
 *   bun  differential.ts [path/to/token-counter.node]
 *
 * Without an argument, resolves vendor/<triple>/token-counter.node the same
 * way packages/token-counter-napi/src/index.ts does.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- vocab ---

const vocabPath = new URL(
  '../native/assets/cl100k_base.tiktoken',
  import.meta.url,
)
const lines = readFileSync(vocabPath, 'utf8').split('\n').filter(Boolean)
const ranks = new Map<string, number>()
for (const line of lines) {
  const sp = line.lastIndexOf(' ')
  const bytes = new Uint8Array(Buffer.from(line.slice(0, sp), 'base64'))
  ranks.set(Array.from(bytes).join(','), Number(line.slice(sp + 1)))
}

// --- JS reference implementation (mirrors vendor_tiktoken.rs) ---

// cl100k pattern; JS has no inline (?i:...) so the first branch is expanded.
const PAT =
  /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu

const MAX_RANK = 0xffffffff

function bytePairMerge(piece: Uint8Array): Array<[number, number]> {
  const parts: Array<[number, number]> = []
  let min: [number, number] = [MAX_RANK, -1]
  for (let i = 0; i < piece.length - 1; i++) {
    const rank = ranks.get(piece.subarray(i, i + 2).join(',')) ?? MAX_RANK
    if (rank < min[0]) min = [rank, i]
    parts.push([i, rank])
  }
  parts.push([piece.length - 1, MAX_RANK])
  parts.push([piece.length, MAX_RANK])
  const getRank = (i: number): number => {
    if (i + 3 < parts.length) {
      return (
        ranks.get(piece.subarray(parts[i][0], parts[i + 3][0]).join(',')) ??
        MAX_RANK
      )
    }
    return MAX_RANK
  }
  while (min[0] !== MAX_RANK) {
    const i = min[1]
    if (i > 0) parts[i - 1][1] = getRank(i - 1)
    parts[i][1] = getRank(i)
    parts.splice(i + 1, 1)
    min = [MAX_RANK, -1]
    for (let j = 0; j < parts.length - 1; j++) {
      if (parts[j][1] < min[0]) min = [parts[j][1], j]
    }
  }
  return parts
}

function bytePairEncode(piece: Uint8Array): number[] {
  if (piece.length === 1) return [ranks.get(piece.join(',')) as number]
  const parts = bytePairMerge(piece)
  const out: number[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(
      ranks.get(
        piece.subarray(parts[i][0], parts[i + 1][0]).join(','),
      ) as number,
    )
  }
  return out
}

function refCountTokens(text: string): number {
  let n = 0
  for (const m of text.matchAll(PAT)) {
    const piece = new Uint8Array(Buffer.from(m[0], 'utf8'))
    n += ranks.has(piece.join(',')) ? 1 : bytePairEncode(piece).length
  }
  return n
}

// --- native module resolution ---

function platformDirName(): string {
  const arch = process.arch
  if (process.platform === 'linux') {
    return arch === 'arm64'
      ? 'aarch64-unknown-linux-gnu'
      : 'x86_64-unknown-linux-gnu'
  }
  if (process.platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc'
  return 'unknown'
}

function resolveNativePath(arg: string | undefined): string | null {
  if (arg) return resolve(arg)
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(
      here,
      '..',
      '..',
      '..',
      'vendor',
      'token-counter',
      platformDirName(),
      'token-counter.node',
    ),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// --- harness ---

let failures = 0
let checked = 0

function expectEqual(label: string, native: number, ref: number): void {
  checked++
  if (native !== ref) {
    failures++
    console.error(`MISMATCH ${label}: native=${native} ref=${ref}`)
  }
}

const nativePath = resolveNativePath(process.argv[2])
if (nativePath === null) {
  console.error('usage: differential.ts [path/to/token-counter.node]')
  process.exit(2)
}
const nodeRequire = createRequire(import.meta.url)
const native = nodeRequire(nativePath) as { countTokens(text: string): number }
console.log(`native module: ${nativePath}`)

// Anchor vectors (truths verified against the vocab table and upstream tests).
const anchors: Array<[string, number]> = [
  ['', 0],
  ['hello world', 2],
  ['hi', 1],
  ['你好，世界', 6],
  ['hi '.repeat(1000), 1001],
  ['a'.repeat(1000), 125],
]
for (const [text, expected] of anchors) {
  expectEqual(
    JSON.stringify(text.slice(0, 24)),
    native.countTokens(text),
    expected,
  )
  if (refCountTokens(text) !== expected) {
    failures++
    console.error(
      `REF ANCHOR BROKEN for ${JSON.stringify(text.slice(0, 24))}: ref=${refCountTokens(text)} expected=${expected}`,
    )
  }
}

// Seeded PRNG so runs are reproducible.
let seed = 0x2f6e2b1
const rand = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}

const fragments = [
  'hello',
  ' world',
  'the quick brown fox',
  '    ',
  '\n\n',
  '\t',
  '42',
  '3.14',
  '你好，世界',
  'こんにちは',
  '안녕하세요',
  '🚀🎉',
  'émoji',
  'café',
  '{"tool":"bash","command":"ls -la","output":"total 0"}',
  '<|endoftext|>',
  'function foo(bar) { return bar.length; }',
  'import { x } from "y";',
  "it's",
  "I'll",
  "we've",
  "they're",
  'ALLCAPS',
  'MiXeD CaSe',
  'a'.repeat(rand(30)),
  ' ',
  '  \n',
  'end.',
  '...',
  '—dash—',
  'tabs\t\ttabs',
]

const ROUNDS = Number(process.env.DIFF_ROUNDS ?? 500)
for (let i = 0; i < ROUNDS; i++) {
  const n = 1 + rand(12)
  const parts: string[] = []
  for (let j = 0; j < n; j++) parts.push(fragments[rand(fragments.length)])
  const text = parts.join(rand(2) === 0 ? '' : ' ')
  expectEqual(`round ${i}`, native.countTokens(text), refCountTokens(text))
}

console.log(`${checked - failures}/${checked} consistent`)
process.exit(failures === 0 ? 0 : 1)
