#!/usr/bin/env bun
/**
 * heapdiff — static diff between two V8 .heapsnapshot files.
 *
 * Purpose (see Phase 0 work package): distinguish "JS live-heap growth" from
 * "allocator retention" after long sessions. Bun.gc(true) may keep RSS high
 * without the JS heap growing; a pair of heap snapshots taken across the
 * replay (or a live session via /heapdump) localizes WHAT grew on the JS
 * side, by self-size — not retained size (no graph walk needed for triage).
 *
 * Parses the V8 snapshot JSON directly (meta.node_types / nodes / edges /
 * strings). Aggregation is by (node type, node name) over self_size, plus a
 * cross-scan of the strings table for large strings and focus keywords.
 *
 * Usage:
 *   bun scripts/heapdiff.ts <a.heapsnapshot> <b.heapsnapshot>
 *     [--top N] [--json] [--focus kw1,kw2,...]
 *
 * Focus keywords default to StylePool,fpsTracker,MessageRow,tokenCache,
 * toolUseId — the suspects for long-session growth in this codebase.
 */
import { statSync } from 'node:fs'

// ─── JSON guards (strict-mode friendly, no `as any`) ─────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  return value.every(v => typeof v === 'number') ? value : null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(v => typeof v === 'string') ? value : null
}

// ─── Types ───────────────────────────────────────────────────────────────

export type AggregateEntry = { count: number; selfSize: number }

export type TopNode = {
  type: string
  name: string
  id: number
  selfSize: number
}

export type TopString = {
  index: number
  length: number
  /** Estimated retained bytes: UTF-16-ish 2 bytes per char. */
  bytes: number
  preview: string
}

export type ParsedSnapshot = {
  path: string
  title: string | null
  nodeFields: string[]
  stride: number
  nodeCount: number
  edgeCount: number
  stringsCount: number
  totalSelfSize: number
  totalStringBytes: number
  byType: Map<string, AggregateEntry>
  /** key: `${typeName}\u0000${name}` */
  byName: Map<string, AggregateEntry>
  topNodes: TopNode[]
  topStrings: TopString[]
  focusStringHits: Map<string, TopString[]>
}

export type DeltaRow = {
  type: string
  name: string
  countA: number
  countB: number
  deltaCount: number
  sizeA: number
  sizeB: number
  deltaSize: number
}

export type FocusStringHit = {
  keyword: string
  inA: TopString[]
  inB: TopString[]
}

export type HeapDiffReport = {
  a: SnapshotSummary
  b: SnapshotSummary
  totals: DeltaRow
  byTypeDelta: DeltaRow[]
  topByNameDelta: DeltaRow[]
  focus: FocusReportKeyword[]
}

export type SnapshotSummary = {
  path: string
  title: string | null
  nodeCount: number
  edgeCount: number
  stringsCount: number
  totalSelfSize: number
  totalStringBytes: number
  topNodes: TopNode[]
  topStrings: TopString[]
}

export type FocusReportKeyword = {
  keyword: string
  nodes: DeltaRow[]
  strings: FocusStringHit
}

export const DEFAULT_FOCUS_KEYWORDS = [
  'StylePool',
  'fpsTracker',
  'MessageRow',
  'tokenCache',
  'toolUseId',
]

// ─── Parsing ─────────────────────────────────────────────────────────────

const NAME_KEY_SEPARATOR = '\u0000'
function nameKey(typeName: string, name: string): string {
  return `${typeName}${NAME_KEY_SEPARATOR}${name}`
}

/** Keep `list` sorted desc by selfSize/bytes, trimmed to maxK entries. */
function insertTop<T>(
  list: T[],
  item: T,
  maxK: number,
  key: (v: T) => number,
): void {
  let i = list.length
  while (i > 0 && key(list[i - 1]!) < key(item)) i -= 1
  if (i >= maxK) return
  list.splice(i, 0, item)
  if (list.length > maxK) list.pop()
}

function bumpAggregate(
  map: Map<string, AggregateEntry>,
  key: string,
  selfSize: number,
): void {
  const entry = map.get(key)
  if (entry) {
    entry.count += 1
    entry.selfSize += selfSize
  } else {
    map.set(key, { count: 1, selfSize })
  }
}

export type ParseOptions = {
  topK?: number
  focusKeywords?: string[]
}

/**
 * Parse one .heapsnapshot (V8 format). Throws a descriptive Error when the
 * file does not look like a V8 heap snapshot.
 */
export async function parseHeapSnapshot(
  path: string,
  options: ParseOptions = {},
): Promise<ParsedSnapshot> {
  const topK = options.topK ?? 20
  const focusKeywords = (options.focusKeywords ?? DEFAULT_FOCUS_KEYWORDS).map(
    k => k.toLowerCase(),
  )

  let json: unknown
  try {
    json = await Bun.file(path).json()
  } catch (err) {
    throw new Error(
      `cannot read heap snapshot ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  const snapshotField = isRecord(json) ? json['snapshot'] : undefined
  if (!isRecord(snapshotField)) {
    throw new Error(
      `${path}: missing "snapshot" object — not a V8 .heapsnapshot`,
    )
  }
  const metaField = snapshotField['meta']
  if (!isRecord(metaField)) {
    throw new Error(`${path}: missing "snapshot.meta" object`)
  }

  const nodeFieldsRaw = metaField['node_fields']
  const nodeFields = asStringArray(nodeFieldsRaw)
  if (!nodeFields || nodeFields.length === 0) {
    throw new Error(`${path}: snapshot.meta.node_fields missing/invalid`)
  }

  // node_types is aligned with node_fields; enum fields carry a string[] or
  // numeric[] table (name-of-type), the rest carry ""/numbers.
  const nodeTypesRaw = metaField['node_types']
  let typeNames: string[] | null = null
  if (Array.isArray(nodeTypesRaw)) {
    for (const entry of nodeTypesRaw) {
      const names = asStringArray(entry)
      if (names && names.length > 0) {
        typeNames = names
        break
      }
    }
  }

  const nodes = asNumberArray(json['nodes'])
  if (!nodes) {
    throw new Error(`${path}: "nodes" missing or not a flat numeric array`)
  }
  const strings = asStringArray(json['strings'])
  if (!strings) {
    throw new Error(`${path}: "strings" missing or not a string array`)
  }

  const typeIdx = nodeFields.indexOf('type')
  const nameIdx = nodeFields.indexOf('name')
  const selfSizeIdx = nodeFields.indexOf('self_size')
  if (typeIdx < 0 || nameIdx < 0 || selfSizeIdx < 0) {
    throw new Error(
      `${path}: node_fields must contain "type", "name" and "self_size" (got: ${nodeFields.join(', ')})`,
    )
  }
  const idIdx = nodeFields.indexOf('id')

  const stride = nodeFields.length
  const nodeCount = Math.floor(nodes.length / (stride > 0 ? stride : 1))

  // Edge arrays are validated for presence/format but are not walked: the
  // aggregate below is self-size based by design (no retained-size walk).
  const edgeFieldsRaw = metaField['edge_fields']
  const edgeFields = asStringArray(edgeFieldsRaw) ?? []
  const edges = asNumberArray(json['edges'])
  const edgeStride = edgeFields.length > 0 ? edgeFields.length : 3
  const edgeCountFromSnapshot =
    typeof snapshotField['edge_count'] === 'number'
      ? snapshotField['edge_count']
      : edges
        ? Math.floor(edges.length / edgeStride)
        : 0

  const byType = new Map<string, AggregateEntry>()
  const byName = new Map<string, AggregateEntry>()
  const topNodes: TopNode[] = []
  const topStrings: TopString[] = []
  const focusStringHits = new Map<string, TopString[]>()
  for (const keyword of focusKeywords) {
    focusStringHits.set(keyword, [])
  }

  let totalSelfSize = 0
  for (let base = 0; base + stride <= nodes.length; base += stride) {
    const rawType = nodes[base + typeIdx]!
    const typeName = typeNames
      ? (typeNames[rawType] ?? `type#${rawType}`)
      : `type#${rawType}`
    const rawName = nodes[base + nameIdx]!
    const name =
      rawName >= 0 && rawName < strings.length ? strings[rawName]! : ''
    const selfSize = nodes[base + selfSizeIdx]!
    totalSelfSize += selfSize

    bumpAggregate(byType, typeName, selfSize)
    bumpAggregate(byName, nameKey(typeName, name), selfSize)

    insertTop(
      topNodes,
      {
        type: typeName,
        name,
        id: idIdx >= 0 ? nodes[base + idIdx]! : base / stride,
        selfSize,
      },
      topK,
      node => node.selfSize,
    )
  }

  // Strings table cross-scan: track the largest strings (2 bytes/char
  // estimate) and, for each focus keyword, where it lives as raw string data.
  let totalStringBytes = 0
  for (let i = 0; i < strings.length; i += 1) {
    const s = strings[i]!
    const len = s.length
    if (len === 0) continue
    totalStringBytes += len * 2
    const hit: TopString = {
      index: i,
      length: len,
      bytes: len * 2,
      preview: len > 120 ? `${s.slice(0, 117)}...` : s,
    }
    insertTop(topStrings, hit, topK, entry => entry.bytes)
    const lowered = len <= 4096 ? s.toLowerCase() : null
    if (lowered !== null) {
      for (const keyword of focusKeywords) {
        if (lowered.includes(keyword)) {
          const hits = focusStringHits.get(keyword)
          if (hits && hits.length < topK) {
            hits.push(hit)
          }
        }
      }
    }
  }

  const title =
    typeof snapshotField['title'] === 'string' ? snapshotField['title'] : null

  return {
    path,
    title,
    nodeFields,
    stride,
    nodeCount,
    edgeCount: edgeCountFromSnapshot,
    stringsCount: strings.length,
    totalSelfSize,
    totalStringBytes,
    byType,
    byName,
    topNodes,
    topStrings,
    focusStringHits,
  }
}

export type BuildReportOptions = {
  top?: number
  focusKeywords?: string[]
}

function summarize(snapshot: ParsedSnapshot): SnapshotSummary {
  return {
    path: snapshot.path,
    title: snapshot.title,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    stringsCount: snapshot.stringsCount,
    totalSelfSize: snapshot.totalSelfSize,
    totalStringBytes: snapshot.totalStringBytes,
    topNodes: snapshot.topNodes.slice(0, 10),
    topStrings: snapshot.topStrings.slice(0, 10),
  }
}

function delta(
  type: string,
  name: string,
  a: AggregateEntry | undefined,
  b: AggregateEntry | undefined,
): DeltaRow {
  const sizeA = a?.selfSize ?? 0
  const sizeB = b?.selfSize ?? 0
  const countA = a?.count ?? 0
  const countB = b?.count ?? 0
  return {
    type,
    name,
    countA,
    countB,
    deltaCount: countB - countA,
    sizeA,
    sizeB,
    deltaSize: sizeB - sizeA,
  }
}

/** Build a structured diff report between two parsed snapshots. */
export function buildHeapDiffReport(
  parsedA: ParsedSnapshot,
  parsedB: ParsedSnapshot,
  options: BuildReportOptions = {},
): HeapDiffReport {
  const top = options.top ?? 25
  const keywords = options.focusKeywords ?? DEFAULT_FOCUS_KEYWORDS

  // Name-level deltas across the union of aggregate keys.
  const nameRows: DeltaRow[] = []
  for (const key of new Set([
    ...parsedA.byName.keys(),
    ...parsedB.byName.keys(),
  ])) {
    const sep = key.lastIndexOf(NAME_KEY_SEPARATOR)
    const type = key.slice(0, sep)
    const name = key.slice(sep + 1)
    nameRows.push(
      delta(type, name, parsedA.byName.get(key), parsedB.byName.get(key)),
    )
  }
  nameRows.sort((r1, r2) => {
    const d = Math.abs(r2.deltaSize) - Math.abs(r1.deltaSize)
    return d !== 0 ? d : Math.abs(r2.deltaCount) - Math.abs(r1.deltaCount)
  })

  // Type-level deltas (compact — always all rows).
  const typeRows: DeltaRow[] = []
  for (const type of new Set([
    ...parsedA.byType.keys(),
    ...parsedB.byType.keys(),
  ])) {
    typeRows.push(
      delta(type, '', parsedA.byType.get(type), parsedB.byType.get(type)),
    )
  }
  typeRows.sort((r1, r2) => Math.abs(r2.deltaSize) - Math.abs(r1.deltaSize))

  const totalsA = parsedA.totalSelfSize
  const totalsB = parsedB.totalSelfSize
  const totals: DeltaRow = {
    type: '*total*',
    name: '',
    countA: parsedA.nodeCount,
    countB: parsedB.nodeCount,
    deltaCount: parsedB.nodeCount - parsedA.nodeCount,
    sizeA: totalsA,
    sizeB: totalsB,
    deltaSize: totalsB - totalsA,
  }

  const loweredKeywords = keywords.map(k => k.toLowerCase())
  const focus: FocusReportKeyword[] = loweredKeywords.map(keyword => {
    const nodes = nameRows.filter(
      row =>
        row.name.toLowerCase().includes(keyword) ||
        row.type.toLowerCase().includes(keyword),
    )
    return {
      keyword,
      nodes: nodes.slice(0, 10),
      strings: {
        keyword,
        inA: parsedA.focusStringHits.get(keyword) ?? [],
        inB: parsedB.focusStringHits.get(keyword) ?? [],
      },
    }
  })

  return {
    a: summarize(parsedA),
    b: summarize(parsedB),
    totals,
    byTypeDelta: typeRows,
    topByNameDelta: nameRows.slice(0, top),
    focus,
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes)
  const sign = bytes < 0 ? '-' : ''
  if (abs < 1024) return `${sign}${abs}B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`
  if (abs < 1024 * 1024 * 1024) {
    return `${sign}${(abs / (1024 * 1024)).toFixed(2)}MB`
  }
  return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + ' '.repeat(width - value.length)
}

function padStart(value: string, width: number): string {
  return value.length >= width
    ? value
    : ' '.repeat(width - value.length) + value
}

function renderRow(row: DeltaRow, labelOverride?: string): string {
  const name =
    labelOverride ??
    (row.type === '*total*' ? '*total*' : row.name || '(anonymous)')
  return [
    `${row.deltaSize >= 0 ? '+' : ''}${formatBytes(row.deltaSize)}`.padStart(
      12,
    ),
    pad(name, 44),
    padStart(`${row.countA}→${row.countB}`, 12),
    padStart(`${formatBytes(row.sizeA)}→${formatBytes(row.sizeB)}`, 30),
  ].join('  ')
}

export function formatHeapDiffReport(report: HeapDiffReport): string {
  const lines: string[] = []
  lines.push('== heapdiff: snapshot A -> B ==')
  for (const [label, sum] of [
    ['A', report.a],
    ['B', report.b],
  ] as const) {
    lines.push(
      `${label}: ${sum.path}`,
      `  nodes=${sum.nodeCount} edges=${sum.edgeCount} strings=${sum.stringsCount}`,
      `  selfSize total=${formatBytes(sum.totalSelfSize)}  strings total≈${formatBytes(sum.totalStringBytes)}`,
    )
  }

  lines.push('', '-- totals --', renderRow(report.totals, '*total*'))

  lines.push(
    '',
    '-- self-size delta by node type (sorted by |Δ|) --',
    ...report.byTypeDelta.map(row => renderRow(row, row.type)),
  )

  lines.push(
    '',
    `-- top name-level deltas (--top) --`,
    ...report.topByNameDelta.map(renderRow),
  )

  lines.push('', '-- top nodes by self-size in B --')
  for (const node of report.b.topNodes) {
    lines.push(
      `  ${formatBytes(node.selfSize).padStart(12)}  ${pad(node.type, 12)}${node.name.slice(0, 40)}`,
    )
  }

  lines.push('', '-- largest strings in B (estimated 2B/char) --')
  for (const s of report.b.topStrings) {
    lines.push(
      `  ${formatBytes(s.bytes).padStart(12)}  len=${s.length}  ${s.preview.slice(0, 60).replace(/\n/g, '\\n')}`,
    )
  }

  for (const f of report.focus) {
    lines.push('', `-- focus "${f.keyword}" --`)
    if (f.nodes.length === 0) {
      lines.push('  no node-name/type matches')
    }
    for (const row of f.nodes) {
      lines.push(`  ${renderRow(row)}`)
    }
    lines.push(
      `  strings: A=${f.strings.inA.length} hit(s), B=${f.strings.inB.length} hit(s)`,
    )
    for (const hit of f.strings.inB.slice(0, 3)) {
      lines.push(
        `    B: len=${hit.length} ${JSON.stringify(hit.preview.slice(0, 80))}`,
      )
    }
  }

  return lines.join('\n')
}

export type { BuildReportOptions as HeapDiffOptions }

/** Convenience for other scripts: load two snapshots and produce a report. */
export async function compareSnapshotFiles(
  pathA: string,
  pathB: string,
  options: BuildReportOptions = {},
): Promise<HeapDiffReport> {
  const [a, b] = await Promise.all([
    parseHeapSnapshot(pathA, options),
    parseHeapSnapshot(pathB, options),
  ])
  return buildHeapDiffReport(a, b, options)
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function parseCliArgs(argv: string[]): {
  pathA: string
  pathB: string
  top: number
  json: boolean
  focus: string[]
} | null {
  const positional: string[] = []
  let top = 25
  let json = false
  let focus: string[] | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--top') {
      i += 1
      top = Number(argv[i])
      if (!Number.isFinite(top) || top <= 0) return null
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--focus') {
      i += 1
      const raw = argv[i]
      if (!raw) return null
      focus = raw
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
    } else if (arg === '--help' || arg === '-h') {
      return null
    } else if (arg !== undefined && arg.startsWith('--')) {
      return null
    } else if (arg !== undefined) {
      positional.push(arg)
    }
  }
  if (positional.length !== 2) return null
  return {
    pathA: positional[0]!,
    pathB: positional[1]!,
    top,
    json,
    focus: focus ?? DEFAULT_FOCUS_KEYWORDS,
  }
}

function usage(): string {
  return [
    'Usage: bun scripts/heapdiff.ts <a.heapsnapshot> <b.heapsnapshot>',
    '       [--top N] [--json] [--focus kw1,kw2,...]',
    '',
    'Diffs two V8 heap snapshots by (type, name) self-size aggregates and',
    'cross-scans the strings table for large strings and focus keywords.',
  ].join('\n')
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2)
  const parsed = parseCliArgs(argv)
  if (!parsed) {
    process.stderr.write(`${usage()}\n`)
    return 1
  }
  for (const p of [parsed.pathA, parsed.pathB]) {
    try {
      if (!statSync(p).isFile()) {
        throw new Error('not a file')
      }
    } catch {
      process.stderr.write(`heapdiff: cannot stat ${p}\n`)
      return 1
    }
  }
  const report = await compareSnapshotFiles(parsed.pathA, parsed.pathB, {
    top: parsed.top,
    focusKeywords: parsed.focus,
  })
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatHeapDiffReport(report))
  }
  return 0
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      process.stderr.write(
        `heapdiff: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    })
}
