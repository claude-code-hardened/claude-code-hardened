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
 * With no paths, scans all .jsonl files under ~/.claude/projects (recursive).
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
  let st: import('node:fs').Stats
  try {
    st = statSync(p)
  } catch {
    return // broken symlink / vanished file — skip
  }
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

// Bun.JSONL.parseChunk when available — mirrors src/utils/json.ts parseJSONL
// so the parse-equivalence check below exercises the production parser. When
// absent (plain node), the check is skipped.
type BunJSONLParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }
const bunJSONLParse: BunJSONLParseChunk | false = (() => {
  const bun = globalThis as unknown as {
    Bun?: { JSONL?: { parseChunk?: BunJSONLParseChunk } }
  }
  const parseChunk = bun.Bun?.JSONL?.parseChunk
  if (typeof parseChunk !== 'function') return false
  return parseChunk
})()

function parseJSONLRef(data: Buffer): unknown[] {
  if (bunJSONLParse === false) return []
  const len = data.length
  const result = bunJSONLParse(data)
  if (!result.error || result.done || result.read >= len) {
    return result.values
  }
  // Had an error mid-stream — collect what we got and keep going
  let values = result.values
  let offset = result.read
  while (offset < len) {
    const newlineIndex = data.indexOf(0x0a, offset)
    if (newlineIndex === -1) break
    offset = newlineIndex + 1
    const next = bunJSONLParse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values)
    }
    if (!next.error || next.done || next.read >= len) break
    offset = next.read
  }
  return values
}

type CompareMetrics = {
  stitched: boolean
  concatBytes: number
  segments: number
  concatParseMs: number
  segmentsParseMs: number
}

function compareFile(
  path: string,
): { ok: boolean; detail: string } & CompareMetrics {
  const buf = readFileSync(path)
  const metrics: CompareMetrics = {
    stitched: false,
    concatBytes: 0,
    segments: 0,
    concatParseMs: 0,
    segmentsParseMs: 0,
  }

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
    return { ok: false, detail: 'msgIndex mismatch', ...metrics }
  }
  const jsMeta = js.metaRanges
  const rsMeta = Array.from(rs.metaRanges)
  if (
    jsMeta.length !== rsMeta.length ||
    jsMeta.some((v, i) => v !== rsMeta[i])
  ) {
    return { ok: false, detail: 'metaRanges mismatch', ...metrics }
  }
  if (js.keepAll !== rs.keepAll) {
    return {
      ok: false,
      detail: `keepAll mismatch js=${js.keepAll} rs=${rs.keepAll}`,
      ...metrics,
    }
  }
  if (js.chainBytes !== rs.chainBytes) {
    return {
      ok: false,
      detail: `chainBytes js=${js.chainBytes} rs=${rs.chainBytes}`,
      ...metrics,
    }
  }
  if (!rs.keepAll) {
    const rsKept = Array.from(rs.keptRanges)
    if (
      js.kept.length !== rsKept.length ||
      js.kept.some((v, i) => v !== rsKept[i])
    ) {
      return { ok: false, detail: 'keptRanges mismatch', ...metrics }
    }
  }

  // Range-only interface: scanChainRanges must agree with scanChain on
  // keptRanges/keepAll/chainBytes (it runs the same scan, minus the ABI
  // copies of msgIndex/metaRanges). Skipped for .node builds that predate it.
  let hasRanges = false
  if (typeof napi.scanChainRanges === 'function') {
    hasRanges = true
    const rr = napi.scanChainRanges(buf)
    const rrKept = Array.from(rr.keptRanges)
    const rsKept = Array.from(rs.keptRanges)
    if (rr.keepAll !== rs.keepAll) {
      return {
        ok: false,
        detail: `ranges keepAll mismatch ${rr.keepAll} vs ${rs.keepAll}`,
        ...metrics,
      }
    }
    if (rr.chainBytes !== rs.chainBytes) {
      return {
        ok: false,
        detail: `ranges chainBytes mismatch ${rr.chainBytes} vs ${rs.chainBytes}`,
        ...metrics,
      }
    }
    if (
      rrKept.length !== rsKept.length ||
      rrKept.some((v, i) => v !== rsKept[i])
    ) {
      return { ok: false, detail: 'ranges keptRanges mismatch', ...metrics }
    }
  }

  // Stitched files: assert parseJSONLSegments semantics — per-segment parse
  // of zero-copy subarray views must produce byte-identical entries to
  // parsing the concatenated buffer (the old walkChainBeforeParse output).
  if (!rs.keepAll && bunJSONLParse !== false) {
    const kept = rs.keptRanges
    const segs: Buffer[] = []
    for (let i = 0; i < kept.length; i += 2) {
      segs.push(buf.subarray(kept[i]!, kept[i + 1]!))
    }
    metrics.stitched = true
    metrics.segments = segs.length

    const tC0 = performance.now()
    const concat = Buffer.concat(segs)
    const whole = parseJSONLRef(concat)
    metrics.concatParseMs = performance.now() - tC0
    metrics.concatBytes = concat.length

    const tS0 = performance.now()
    const perSeg: unknown[] = []
    for (const seg of segs) {
      for (const v of parseJSONLRef(seg)) perSeg.push(v)
    }
    metrics.segmentsParseMs = performance.now() - tS0

    if (whole.length !== perSeg.length) {
      return {
        ok: false,
        detail: `parse mismatch: concat ${whole.length} vs segments ${perSeg.length}`,
        ...metrics,
      }
    }
    for (let i = 0; i < whole.length; i++) {
      if (JSON.stringify(whole[i]) !== JSON.stringify(perSeg[i])) {
        return {
          ok: false,
          detail: `parse value mismatch at entry ${i}`,
          ...metrics,
        }
      }
    }
  }
  if (hasRanges) {
    rangesChecked++
  }
  return {
    ok: true,
    detail: `js=${jsMs.toFixed(0)}ms rs=${rsMs.toFixed(0)}ms`,
    ...metrics,
  }
}

let passed = 0
let failed = 0
let totalRsMs = 0
let totalJsMs = 0
let rangesChecked = 0
let stitchedFiles = 0
let totalConcatBytes = 0
let totalConcatParseMs = 0
let totalSegmentsParseMs = 0
for (const f of files) {
  try {
    const r = compareFile(f)
    if (r.ok) {
      passed++
      const m = /js=([0-9.]+)ms rs=([0-9.]+)ms/.exec(r.detail)
      if (m) {
        totalJsMs += Number(m[1])
        totalRsMs += Number(m[2])
      }
      if (r.stitched) {
        stitchedFiles++
        totalConcatBytes += r.concatBytes
        totalConcatParseMs += r.concatParseMs
        totalSegmentsParseMs += r.segmentsParseMs
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
    ` (js ${totalJsMs.toFixed(0)}ms, rust ${totalRsMs.toFixed(0)}ms)`,
)
console.log(
  `ranges: ${rangesChecked} files via scanChainRanges` +
    (rangesChecked === 0
      ? ' (native build predates scanChainRanges — skipped)'
      : ''),
)
console.log(
  `parse-equiv: ${stitchedFiles} stitched files, per-segment === concat` +
    ` (${totalConcatParseMs.toFixed(0)}ms concat+parse vs ${totalSegmentsParseMs.toFixed(0)}ms segments)`,
)
console.log(
  `memory: concat path allocates ${(totalConcatBytes / 1048576) | 0}MB of stitched copies;` +
    ` ranges path allocates 0 (subarray views alias the input buffer)`,
)
process.exit(failed === 0 ? 0 : 1)
