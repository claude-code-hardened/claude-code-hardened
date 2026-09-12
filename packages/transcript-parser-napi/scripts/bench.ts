#!/usr/bin/env bun
/**
 * Performance benchmark for transcript chain scanning on real session files.
 *
 * Compares three paths over the same JSONL buffer:
 *   A. full-line JSON.parse (the naive pre-optimization path)
 *   B. JS byte scanner + parse of kept lines (walkChainBeforeParse, verbatim)
 *   C. Rust scan_chain + parse of kept lines (native)
 *
 * Zero npm dependencies. Acceptance targets (B4, plan
 * quiet-splashing-squid.md): 189MB file ≤1.0s end-to-end for the parse
 * path, 70MB ≤0.5s, memory peak visibly below the naive path.
 *
 * Usage:
 *   bun run packages/transcript-parser-napi/scripts/bench.ts \
 *     <transcript-parser.node> [<jsonl> ...]
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const nodePath = process.argv[2]
if (!nodePath || !existsSync(nodePath)) {
  console.error('usage: bench.ts <transcript-parser.node> [jsonl files...]')
  process.exit(2)
}
const nodeRequire = createRequire(import.meta.url)
const napi = nodeRequire(nodePath)

const paths = process.argv.slice(3)
const files: string[] = []
function collect(p: string): void {
  let st: import('node:fs').Stats
  try {
    st = statSync(p)
  } catch {
    return // broken symlink / vanished file — skip
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) collect(join(p, e))
  } else if (p.endsWith('.jsonl') && st.size > 5 * 1024 * 1024) {
    files.push(p)
  }
}
if (paths.length === 0) {
  collect(join(process.env.HOME ?? '/root', '.claude', 'projects'))
} else {
  for (const p of paths) collect(p)
}
files.sort((a, b) => statSync(b).size - statSync(a).size)

// --- Verbatim JS reference (same extraction as differential.ts) -----------
const PARENT_PREFIX = Buffer.from('{"parentUuid":')
const UUID_KEY = Buffer.from('"uuid":"')
const SIDECHAIN_TRUE = Buffer.from('"isSidechain":true')
const UUID_LEN = 36
const TS_SUFFIX = Buffer.from('","timestamp":"')
const PREFIX_LEN = PARENT_PREFIX.length
const KEY_LEN = UUID_KEY.length
const TS_SUFFIX_LEN = TS_SUFFIX.length

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d

function pickDepthOneUuidCandidate(
  buf: Buffer,
  lineStart: number,
  candidates: number[],
): number {
  let depth = 0
  let inString = false
  let escapeNext = false
  let ci = 0
  for (let i = lineStart; ci < candidates.length; i++) {
    if (i === candidates[ci]) {
      if (depth === 1 && !inString) return candidates[ci]!
      ci++
    }
    const b = buf[i]!
    if (escapeNext) {
      escapeNext = false
    } else if (inString) {
      if (b === BACKSLASH) escapeNext = true
      else if (b === QUOTE) inString = false
    } else if (b === QUOTE) inString = true
    else if (b === OPEN_BRACE) depth++
    else if (b === CLOSE_BRACE) depth--
  }
  return candidates.at(-1)!
}

function walkChainBeforeParseRef(buf: Buffer): {
  keepAll: boolean
  kept: number[]
} {
  const NEWLINE = 0x0a
  const OPEN_BRACE = 0x7b
  const msgIdx: number[] = []
  const metaRanges: number[] = []
  const uuidToSlot = new Map<string, number>()
  let pos = 0
  const len = buf.length
  while (pos < len) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? len : nl + 1
    if (
      lineEnd - pos > PREFIX_LEN &&
      buf[pos] === OPEN_BRACE &&
      buf.compare(PARENT_PREFIX, 0, PREFIX_LEN, pos, pos + PREFIX_LEN) === 0
    ) {
      const parentStart =
        buf[pos + PREFIX_LEN] === QUOTE ? pos + PREFIX_LEN + 1 : -1
      let firstAny = -1
      let suffix0 = -1
      let suffixN: number[] | undefined
      let from = pos
      for (;;) {
        const next = buf.indexOf(UUID_KEY, from)
        if (next < 0 || next >= lineEnd) break
        if (firstAny < 0) firstAny = next
        const after = next + KEY_LEN + UUID_LEN
        if (
          after + TS_SUFFIX_LEN <= lineEnd &&
          buf.compare(
            TS_SUFFIX,
            0,
            TS_SUFFIX_LEN,
            after,
            after + TS_SUFFIX_LEN,
          ) === 0
        ) {
          if (suffix0 < 0) suffix0 = next
          else (suffixN ??= [suffix0]).push(next)
        }
        from = next + KEY_LEN
      }
      const uk = suffixN
        ? pickDepthOneUuidCandidate(buf, pos, suffixN)
        : suffix0 >= 0
          ? suffix0
          : firstAny
      if (uk >= 0) {
        const uuidStart = uk + KEY_LEN
        const uuid = buf.toString('latin1', uuidStart, uuidStart + UUID_LEN)
        uuidToSlot.set(uuid, msgIdx.length)
        msgIdx.push(pos, lineEnd, parentStart)
      } else {
        metaRanges.push(pos, lineEnd)
      }
    } else {
      metaRanges.push(pos, lineEnd)
    }
    pos = lineEnd
  }
  let leafSlot = -1
  for (let i = msgIdx.length - 3; i >= 0; i -= 3) {
    const sc = buf.indexOf(SIDECHAIN_TRUE, msgIdx[i]!)
    if (sc === -1 || sc >= msgIdx[i + 1]!) {
      leafSlot = i
      break
    }
  }
  if (leafSlot < 0) return { keepAll: true, kept: [] }
  const seen = new Set<number>()
  const chain = new Set<number>()
  let chainBytes = 0
  let slot: number | undefined = leafSlot
  while (slot !== undefined) {
    if (seen.has(slot)) break
    seen.add(slot)
    chain.add(msgIdx[slot]!)
    chainBytes += msgIdx[slot + 1]! - msgIdx[slot]!
    const parentStart = msgIdx[slot + 2]!
    if (parentStart < 0) break
    const parent = buf.toString('latin1', parentStart, parentStart + UUID_LEN)
    slot = uuidToSlot.get(parent)
  }
  if (len - chainBytes < len >> 1) return { keepAll: true, kept: [] }
  const kept: number[] = []
  let m = 0
  for (let i = 0; i < msgIdx.length; i += 3) {
    const start = msgIdx[i]!
    while (m < metaRanges.length && metaRanges[m]! < start) {
      kept.push(metaRanges[m]!, metaRanges[m + 1]!)
      m += 2
    }
    if (chain.has(start)) kept.push(start, msgIdx[i + 1]!)
  }
  while (m < metaRanges.length) {
    kept.push(metaRanges[m]!, metaRanges[m + 1]!)
    m += 2
  }
  return { keepAll: false, kept }
}

// --- Bench -----------------------------------------------------------------
// Some transcript lines are truncated/invalid JSON (9 bad lines in the
// 189MB sample) — swallow and continue, timing is what matters here.
function parseAll(buf: Buffer): void {
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      try {
        JSON.parse(buf.toString('utf-8', start, i))
      } catch {
        // bad line — skip
      }
      start = i + 1
    }
  }
}

function benchFile(path: string): void {
  const size = statSync(path).size
  const t0 = performance.now()
  const buf = readFileSync(path)
  const readMs = performance.now() - t0

  // A: naive full parse
  const tA0 = performance.now()
  parseAll(buf)
  const aMs = performance.now() - tA0

  // B: JS scanner + parse kept
  const tB0 = performance.now()
  const ref = walkChainBeforeParseRef(buf)
  let bBuf = buf
  if (!ref.keepAll) {
    const parts: Buffer[] = []
    for (let i = 0; i < ref.kept.length; i += 2) {
      parts.push(buf.subarray(ref.kept[i]!, ref.kept[i + 1]!))
    }
    bBuf = Buffer.concat(parts)
  }
  const tB1 = performance.now()
  parseAll(bBuf)
  const bMs = performance.now() - tB0
  const jsScanMs = tB1 - tB0

  // C: Rust scanner + parse kept
  const tC0 = performance.now()
  const scan = napi.scanChain(buf)
  let cBuf = buf
  if (!scan.keepAll) {
    const kept = scan.keptRanges
    const parts: Buffer[] = []
    for (let i = 0; i < kept.length; i += 2) {
      parts.push(buf.subarray(kept[i], kept[i + 1]))
    }
    cBuf = Buffer.concat(parts)
  }
  const tC1 = performance.now()
  parseAll(cBuf)
  const cMs = performance.now() - tC0
  const rsScanMs = tC1 - tC0

  const mb = (size / 1024 / 1024).toFixed(1)
  const keptPct = ((cBuf.length / buf.length) * 100).toFixed(0)
  console.log(
    `${path.split('/').pop()}  ${mb}MB  keepAll=${scan.keepAll} keptBytes=${keptPct}%  read=${readMs.toFixed(0)}ms`,
  )
  console.log(
    `  [A] naive parse ${aMs.toFixed(0)}ms`,
  )
  console.log(
    `  [B] js scan ${(jsScanMs).toFixed(0)}ms + parse ${bMs.toFixed(0)}ms = ${(jsScanMs + bMs).toFixed(0)}ms`,
  )
  console.log(
    `  [C] rust scan ${(rsScanMs).toFixed(0)}ms + parse ${cMs.toFixed(0)}ms = ${(rsScanMs + cMs).toFixed(0)}ms`,
  )
  console.log('')
}

console.log(`bun ${Bun.version} — transcript scan benchmark\n`)
for (const f of files.slice(0, 12)) {
  try {
    benchFile(f)
  } catch (e) {
    console.log(`${f}: ${(e as Error).message}\n`)
  }
}
