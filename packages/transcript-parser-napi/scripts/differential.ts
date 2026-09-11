#!/usr/bin/env bun
/**
 * Differential test: JS byte scanner (verbatim extraction from
 * src/utils/sessionStorage.ts) vs Rust scan_chain — run over real
 * transcript JSONL files. Zero npm dependencies (only bun + the .node
 * artifact) so it runs anywhere without a node_modules.
 *
 * Usage:
 *   bun run packages/transcript-parser-napi/scripts/differential.ts \
 *     <path-to-transcript-parser.node> [<jsonl-or-dir> ...]
 *
 * With no paths, scans ~/.claude/projects/**/*.jsonl.
 * Exit 0 = 100% match. Any mismatch prints details and exits 1.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const nodePath = process.argv[2]
if (!nodePath || !existsSync(nodePath)) {
  console.error('usage: differential.ts <transcript-parser.node> [paths...]')
  process.exit(2)
}
const nodeRequire = createRequire(import.meta.url)
const napi = nodeRequire(nodePath)

const paths = process.argv.slice(3)
const files: string[] = []
function collect(p: string): void {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) collect(join(p, e))
  } else if (p.endsWith('.jsonl')) {
    files.push(p)
  }
}
if (paths.length === 0) {
  const home = process.env.HOME ?? '/root'
  collect(join(home, '.claude', 'projects'))
} else {
  for (const p of paths) collect(p)
}

// ---------------------------------------------------------------------------
// VERBATIM extraction of the JS reference from src/utils/sessionStorage.ts
// (walkChainBeforeParse + pickDepthOneUuidCandidate + METADATA consts).
// Source of truth: sessionStorage.ts@<this commit>. If the original changes,
// re-extract here — otherwise this test is self-confirming.
// ---------------------------------------------------------------------------
const PARENT_PREFIX = Buffer.from('{"parentUuid":')
const UUID_KEY = Buffer.from('"uuid":"')
const SIDECHAIN_TRUE = Buffer.from('"isSidechain":true')
const UUID_LEN = 36
const TS_SUFFIX = Buffer.from('","timestamp":"')
const PREFIX_LEN = PARENT_PREFIX.length
const KEY_LEN = UUID_KEY.length
const TS_SUFFIX_LEN = TS_SUFFIX.length

function pickDepthOneUuidCandidate(
  buf: Buffer,
  lineStart: number,
  candidates: number[],
): number {
  const QUOTE = 0x22
  const BACKSLASH = 0x5c
  const OPEN_BRACE = 0x7b
  const CLOSE_BRACE = 0x7d
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

type JsScan = {
  msgIdx: number[]
  metaRanges: number[]
  chainBytes: number
  keepAll: boolean
  kept: number[]
}

function walkChainBeforeParseRef(buf: Buffer): JsScan {
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
  if (leafSlot < 0)
    return { msgIdx, metaRanges, chainBytes: 0, keepAll: true, kept: [] }

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

  if (len - chainBytes < len >> 1)
    return { msgIdx, metaRanges, chainBytes, keepAll: true, kept: [] }

  const kept: number[] = []
  let m = 0
  for (let i = 0; i < msgIdx.length; i += 3) {
    const start = msgIdx[i]!
    while (m < metaRanges.length && metaRanges[m]! < start) {
      kept.push(metaRanges[m]!, metaRanges[m + 1]!)
      m += 2
    }
    if (chain.has(start)) {
      kept.push(start, msgIdx[i + 1]!)
    }
  }
  while (m < metaRanges.length) {
    kept.push(metaRanges[m]!, metaRanges[m + 1]!)
    m += 2
  }
  return { msgIdx, metaRanges, chainBytes, keepAll: false, kept }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
const U32_NULL = 0xffffffff

function compareFile(path: string): { ok: boolean; detail: string } {
  const buf = readFileSync(path)

  const t0 = performance.now()
  const js = walkChainBeforeParseRef(buf)
  const jsMs = performance.now() - t0

  const t1 = performance.now()
  const rs = napi.scanChain(buf)
  const rsMs = performance.now() - t1

  // msg index (parentStart: -1 → 0xffffffff)
  const jsMsg = js.msgIdx.slice()
  for (let i = 2; i < jsMsg.length; i += 3) {
    if (jsMsg[i] === -1) jsMsg[i] = U32_NULL
  }
  const rsMsg = Array.from(rs.msgIndex)
  if (jsMsg.length !== rsMsg.length || jsMsg.some((v, i) => v !== rsMsg[i])) {
    return { ok: false, detail: 'msgIndex mismatch' }
  }
  const jsMeta = js.metaRanges
  const rsMeta = Array.from(rs.metaRanges)
  if (jsMeta.length !== rsMeta.length || jsMeta.some((v, i) => v !== rsMeta[i])) {
    return { ok: false, detail: 'metaRanges mismatch' }
  }
  if (js.keepAll !== rs.keepAll) {
    return { ok: false, detail: `keepAll mismatch js=${js.keepAll} rs=${rs.keepAll}` }
  }
  if (js.chainBytes !== rs.chainBytes) {
    return { ok: false, detail: `chainBytes js=${js.chainBytes} rs=${rs.chainBytes}` }
  }
  if (!rs.keepAll) {
    const rsKept = Array.from(rs.keptRanges)
    if (js.kept.length !== rsKept.length || js.kept.some((v, i) => v !== rsKept[i])) {
      return { ok: false, detail: 'keptRanges mismatch' }
    }
  }
  return { ok: true, detail: `js=${jsMs.toFixed(0)}ms rs=${rsMs.toFixed(0)}ms` }
}

let passed = 0
let failed = 0
let totalRsMs = 0
let totalJsMs = 0
for (const f of files) {
  try {
    const r = compareFile(f)
    if (r.ok) {
      passed++
      const m = /rs=([0-9.]+)ms js=([0-9.]+)ms/.exec(r.detail)
      if (m) {
        totalRsMs += Number(m[1])
        totalJsMs += Number(m[2])
      }
    } else {
      failed++
      console.log(`MISMATCH ${f}: ${r.detail}`)
    }
  } catch (e) {
    failed++
    console.log(`ERROR ${f}: ${(e as Error).message}`)
  }
}
console.log(
  `differential: ${passed}/${passed + failed} files match` +
    ` (js total ${totalJsMs.toFixed(0)}ms, rust total ${totalRsMs.toFixed(0)}ms)`,
)
process.exit(failed === 0 ? 0 : 1)
