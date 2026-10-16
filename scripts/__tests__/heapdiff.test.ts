import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  buildHeapDiffReport,
  compareSnapshotFiles,
  DEFAULT_FOCUS_KEYWORDS,
  formatBytes,
  formatHeapDiffReport,
  parseHeapSnapshot,
} from '../heapdiff.ts'

const SEP = '\u0000'

// Minimal V8-shaped snapshot: node stride 4 = [type, name, id, self_size],
// node name indexes into the strings table.
type MiniNode = [type: number, name: number, id: number, selfSize: number]

function snapshotJson(nodes: MiniNode[], strings: string[], title: string) {
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size'],
        node_types: [['hidden', 'native', 'object', 'string']],
        edge_fields: ['type', 'name_or_index', 'to_node'],
      },
      title,
      edge_count: 0,
    },
    nodes: nodes.flat(),
    edges: [],
    strings,
  }
}

// A: object Foo (100B) + native bar (50B) + string node (25B). Self-size
// total 175. B: Foo ×2 (200B), bar unchanged, +300B toolUseId-cache object,
// string node gone. Self-size total = 100+100+50+300 = 550.
const nodesA: MiniNode[] = [
  [2, 0, 1, 100],
  [1, 1, 2, 50],
  [3, 2, 3, 25],
]
const stringsA = ['Foo', 'bar', 'StylePool-ish', 'a StylePool cache entry 0']
const nodesB: MiniNode[] = [
  [2, 0, 1, 100],
  [2, 0, 4, 100],
  [1, 1, 2, 50],
  // Name index 2 = 'toolUseId-cache' in stringsB. It pointed at 3 before
  // (CI log /tmp/test1c.log:342, 380): heapdiff.ts:276 maps an out-of-range
  // name index to '' so the node aggregated under an empty name, the
  // 'toolUseId-cache' by-name row never existed, and the reversed-direction
  // test saw `topByNameDelta[0].name === ''`.
  [2, 2, 5, 300],
]
const stringsB = ['Foo', 'bar', 'toolUseId-cache']

let fixtureDir: string | undefined
function fixturePath(name: string): string {
  fixtureDir ??= mkdtempSync(join(tmpdir(), 'heapdiff-test-'))
  return join(fixtureDir, name)
}

function writeFixture(
  name: string,
  nodes: MiniNode[],
  strings: string[],
  title: string,
): string {
  const path = fixturePath(name)
  writeFileSync(path, JSON.stringify(snapshotJson(nodes, strings, title)))
  return path
}

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
})

describe('parseHeapSnapshot', () => {
  test('aggregates self-size by type and by name', async () => {
    const path = writeFixture('a.heapsnapshot', nodesA, stringsA, 'snap-a')
    const parsed = await parseHeapSnapshot(path)
    expect(parsed.nodeCount).toBe(3)
    expect(parsed.stride).toBe(4)
    expect(parsed.totalSelfSize).toBe(175)
    expect(parsed.title).toBe('snap-a')
    expect(parsed.byType.get('object')).toEqual({ count: 1, selfSize: 100 })
    expect(parsed.byType.get('native')).toEqual({ count: 1, selfSize: 50 })
    expect(parsed.byType.get('string')).toEqual({ count: 1, selfSize: 25 })
    expect(parsed.byName.get(`object${SEP}Foo`)).toEqual({
      count: 1,
      selfSize: 100,
    })
    // Top nodes sorted desc by self-size.
    expect(parsed.topNodes[0]?.name).toBe('Foo')
    expect(parsed.topNodes[0]?.selfSize).toBe(100)
  })

  test('cross-scans strings (largest strings + focus keyword hits)', async () => {
    const path = writeFixture('a2.heapsnapshot', nodesA, stringsA, 'snap-a2')
    const parsed = await parseHeapSnapshot(path)
    expect(parsed.stringsCount).toBe(4)
    // 'a StylePool cache entry 0' — 25 chars → 50 bytes at 2B/char estimate.
    expect(parsed.topStrings[0]?.length).toBe(25)
    expect(parsed.topStrings[0]?.bytes).toBe(50)
    const hits = parsed.focusStringHits.get('stylepool')
    expect(hits?.length).toBe(2)
  })

  test('parses the second snapshot deterministically', async () => {
    const path = writeFixture('b.heapsnapshot', nodesB, stringsB, 'snap-b')
    const parsed = await parseHeapSnapshot(path)
    expect(parsed.nodeCount).toBe(4)
    // 100 + 100 + 50 + 300. (650 in the original draft was an arithmetic
    // slip: 650 - 175 would be 475, contradicting the asserted 375 delta.)
    expect(parsed.totalSelfSize).toBe(550)
    expect(parsed.title).toBe('snap-b')
  })

  test('rejects non-snapshot JSON with a descriptive error', async () => {
    const path = fixturePath('bad.heapsnapshot')
    writeFileSync(path, JSON.stringify({ hello: 'world' }))
    const caught = await parseHeapSnapshot(path).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(caught).toContain('not a V8 .heapsnapshot')
  })
})

describe('buildHeapDiffReport', () => {
  test('totals, by-type deltas and top name-level deltas are correct', async () => {
    const pathA = writeFixture(
      'diff-a.heapsnapshot',
      nodesA,
      stringsA,
      'snap-a',
    )
    const pathB = writeFixture(
      'diff-b.heapsnapshot',
      nodesB,
      stringsB,
      'snap-b',
    )
    const [a, b] = await Promise.all([
      parseHeapSnapshot(pathA),
      parseHeapSnapshot(pathB),
    ])
    const report = buildHeapDiffReport(a, b, {
      top: 10,
      focusKeywords: ['toolUseId'],
    })
    // Totals: 550 - 175 = 375 self-size growth, +1 node (4 in B vs 3 in A).
    expect(report.totals.deltaSize).toBe(375)
    expect(report.totals.deltaCount).toBe(1)
    // Type-level: objects are Foo(100)×1 in A vs Foo(100)×2 + toolUseId(300)
    // in B → +400 size, +2 count; string -25 (gone); native 0.
    const objectRow = report.byTypeDelta.find(row => row.type === 'object')
    expect(objectRow?.deltaSize).toBe(400)
    expect(objectRow?.deltaCount).toBe(2)
    const stringRow = report.byTypeDelta.find(row => row.type === 'string')
    expect(stringRow?.deltaSize).toBe(-25)
    expect(stringRow?.countB).toBe(0)
    // Sorted by |Δ|: the new 300B object is the largest name-level delta.
    expect(report.topByNameDelta[0]?.name).toBe('toolUseId-cache')
    expect(report.topByNameDelta[0]?.deltaSize).toBe(300)
    expect(report.topByNameDelta[0]?.countA).toBe(0)
    expect(report.topByNameDelta[0]?.countB).toBe(1)
    expect(report.topByNameDelta[1]?.name).toBe('Foo')
    expect(report.topByNameDelta[1]?.deltaSize).toBe(100)
    expect(report.topByNameDelta[1]?.countA).toBe(1)
    expect(report.topByNameDelta[1]?.countB).toBe(2)
    // Focus view: nodes match the keyword by node name; the strings
    // cross-scan is string-table-wide, and B's table literally contains
    // 'toolUseId-cache' (the node name IS a strings-table entry), so inB
    // holds exactly 1 hit (CI /tmp/test2.log:316 — expected 0, received 1).
    expect(report.focus).toHaveLength(1)
    expect(report.focus[0]?.keyword).toBe('tooluseid')
    expect(report.focus[0]?.nodes.length).toBeGreaterThan(0)
    expect(report.focus[0]?.strings.inA).toHaveLength(0)
    expect(report.focus[0]?.strings.inB).toHaveLength(1)
    expect(report.focus[0]?.strings.inB[0]?.preview).toBe('toolUseId-cache')
    expect(report.focus[0]?.strings.inB[0]?.bytes).toBe(30)
  })

  test('keys missing on one side count as zero', async () => {
    const pathA = writeFixture('rev-a.heapsnapshot', nodesA, stringsA, 'snap-a')
    const pathB = writeFixture('rev-b.heapsnapshot', nodesB, stringsB, 'snap-b')
    const [a, b] = await Promise.all([
      parseHeapSnapshot(pathA),
      parseHeapSnapshot(pathB),
    ])
    const report = buildHeapDiffReport(b, a, { top: 10 })
    // Reversed direction: the +300B object disappears (−300), so it leads.
    expect(report.topByNameDelta[0]?.name).toBe('toolUseId-cache')
    expect(report.topByNameDelta[0]?.deltaSize).toBe(-300)
    expect(report.topByNameDelta[0]?.countA).toBe(1)
    expect(report.topByNameDelta[0]?.countB).toBe(0)
    const stringRow = report.topByNameDelta.find(
      row => row.name === 'StylePool-ish',
    )
    expect(stringRow?.deltaSize).toBe(25)
    expect(stringRow?.countA).toBe(0)
    expect(stringRow?.countB).toBe(1)
  })
})

describe('compareSnapshotFiles', () => {
  test('end-to-end: parses both files and renders the report', async () => {
    const pathA = writeFixture('e2e-a.heapsnapshot', nodesA, stringsA, 'snap-a')
    const pathB = writeFixture('e2e-b.heapsnapshot', nodesB, stringsB, 'snap-b')
    const report = await compareSnapshotFiles(pathA, pathB, {
      focusKeywords: DEFAULT_FOCUS_KEYWORDS,
    })
    expect(report.totals.deltaSize).toBe(375)
    expect(report.a.path).toBe(pathA)
    expect(report.b.title).toBe('snap-b')
    const rendered = formatHeapDiffReport(report)
    expect(rendered).toContain('== heapdiff: snapshot A -> B')
    expect(rendered).toContain('*total*')
    expect(rendered).toContain('-- self-size delta by node type')
  })
})

describe('formatBytes', () => {
  test('renders B/KB/MB/GB with sign', () => {
    expect(formatBytes(999)).toBe('999B')
    expect(formatBytes(2048)).toBe('2.0KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00GB')
    expect(formatBytes(-(3 * 1024 * 1024 * 1024))).toBe('-3.00GB')
  })
})
