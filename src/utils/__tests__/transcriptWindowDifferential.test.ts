import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { UUID } from 'crypto'

// Differential: the nativeWindow fast path of loadTranscriptFile (window +
// meta lines fed in, as the Rust pipeline hands them back) must produce the
// same collection results as the full-parse path on the same file. The
// native .node binary is NOT required: the "simulated native" below
// produces the tailLines/metaLines the Rust pipeline would return, by
// selecting raw file lines for the full-parse chain's uuids — that is
// exactly load_transcript_window_from_file's contract.

const { loadTranscriptFile, buildConversationChain, findLatestMessage } =
  await import('../sessionStorage.js')

function asUuid(s: string): UUID {
  return s as unknown as UUID
}

let tempDir: string
let sessionFile: string

function msgLine(parent: string | null, uuid: string, i: number): string {
  return JSON.stringify({
    parentUuid: parent,
    type: 'assistant',
    uuid,
    // Monotonic like real transcripts — findLatestMessage's tie-breaking on
    // equal timestamps takes the FIRST traversed terminal, which would
    // otherwise anchor the chain at a sidechain sibling instead of the tail.
    timestamp: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
    message: { usage: { input_tokens: i, output_tokens: 2 } },
  })
}

function buildFixture(): string[] {
  // 60-message chain with: summary meta, custom-title meta mid-file, a
  // sidechain run, a dead fork branch, and a legacy progress line in-chain.
  const lines: string[] = []
  lines.push('{"type":"summary","summary":"s1","leafUuid":"leaf-a"}')
  let parent: string | null = null
  for (let i = 0; i < 60; i++) {
    const uuid = `m-${i}`
    if (i === 30) {
      lines.push(
        JSON.stringify({
          parentUuid: parent,
          type: 'progress',
          uuid,
          timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      )
    } else {
      lines.push(msgLine(parent, uuid, i))
    }
    if (i === 10) {
      // Sidechain/fork rows hang off message #10 with timestamps in the
      // SAME second (+ms offsets) — real transcripts write branches right
      // after their mount point, so they sort BEFORE the chain tail.
      const ts = (ms: number) =>
        `2026-01-01T00:00:${String(i).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`
      lines.push(
        JSON.stringify({
          parentUuid: parent,
          type: 'assistant',
          isSidechain: true,
          uuid: `side-${i}-0`,
          timestamp: ts(100),
          message: { usage: { input_tokens: 900, output_tokens: 1 } },
        }),
      )
      lines.push(
        JSON.stringify({
          parentUuid: `side-${i}-0`,
          type: 'assistant',
          isSidechain: true,
          uuid: `side-${i}-1`,
          timestamp: ts(200),
          message: { usage: { input_tokens: 901, output_tokens: 1 } },
        }),
      )
      lines.push(
        JSON.stringify({
          parentUuid: parent,
          type: 'assistant',
          uuid: `fork-${i}`,
          timestamp: ts(300),
          message: { usage: { input_tokens: 902, output_tokens: 1 } },
        }),
      )
      lines.push(
        JSON.stringify({
          type: 'custom-title',
          sessionId: 'sess-1',
          customTitle: 't',
        }),
      )
    }
    parent = uuid
  }
  return lines
}

/** Simulated native: raw file lines for the given chain uuids (file order)
 *  plus all non-message lines. Mirrors load_transcript_window_from_file. */
function simulatedNative(
  lines: string[],
  chainUuids: Set<string>,
): { tailLines: string[]; metaLines: string[]; progressLines: string[] } {
  // Mirrors load_transcript_window_from_file's contract: message lines
  // (parentUuid-prefixed, which the Rust scanner puts in msg_idx) are
  // EITHER on the chain (tail_lines) or DROPPED — off-chain message rows
  // (dead forks, sidechains, legacy progress) cross no ABI. Only
  // metadata-classified lines ride along as meta_lines.
  const tailLines: string[] = []
  const metaLines: string[] = []
  const progressLines: string[] = []
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as { uuid?: string; type?: string }
      if (v.uuid && chainUuids.has(v.uuid)) {
        tailLines.push(line)
      } else if (v.type === 'progress') {
        // chain progress rows ride back separately (the bridge source)
        progressLines.push(line)
      } else if (v.uuid) {
      } else {
        metaLines.push(line)
      }
    } catch {
      metaLines.push(line)
    }
  }
  return { tailLines, metaLines, progressLines }
}

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `twn-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  sessionFile = join(tempDir, 'sess.jsonl')
  writeFileSync(sessionFile, buildFixture().join('\n') + '\n')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('transcript window differential (nativeWindow vs full parse)', () => {
  test('windowed collection matches full-parse collection for the shared tail', async () => {
    for (const tail of [1, 3, 10, 59, 200]) {
      // Path A: full parse → active chain → tail slice
      const full = await loadTranscriptFile(sessionFile)
      const mostRecentLeaf = findLatestMessage(
        full.messages.values(),
        m => full.leafUuids.has(m.uuid) && m.type === 'assistant',
      )
      expect(mostRecentLeaf).toBeDefined()
      const chain = buildConversationChain(full.messages, mostRecentLeaf!)
      const tailUuids = new Set(chain.slice(-tail).map(m => m.uuid))
      const tailRows = new Map(chain.slice(-tail).map(m => [m.uuid, m]))

      // Path B: simulated native lines → nativeWindow branch
      const native = simulatedNative(buildFixture(), tailUuids)
      const win = await loadTranscriptFile(sessionFile, {
        nativeWindow: {
          tailLines: native.tailLines,
          metaLines: native.metaLines,
          progressLines: native.progressLines,
        },
      })

      // Same leaf → same chain head.
      const winLeaf = findLatestMessage(
        win.messages.values(),
        m => win.leafUuids.has(m.uuid) && m.type === 'assistant',
      )
      expect(winLeaf).toBeDefined()
      expect(winLeaf!.uuid).toBe(mostRecentLeaf!.uuid)

      // Every tail message parses to the same content in both paths.
      const winChain = buildConversationChain(win.messages, winLeaf!)
      expect(winChain.length).toBe(tail)
      for (const m of winChain) {
        const expected = tailRows.get(m.uuid)
        expect(expected).toBeDefined()
        expect(m.parentUuid).toBe(expected!.parentUuid)
        expect(m.type).toBe(expected!.type)
        expect(
          (m.message as { usage?: { input_tokens?: number } })?.usage
            ?.input_tokens,
        ).toBe(
          (expected!.message as { usage?: { input_tokens?: number } })?.usage
            ?.input_tokens,
        )
      }

      // Metadata collected identically through either path.
      expect(win.customTitles.get(asUuid('sess-1'))).toBe(
        full.customTitles.get(asUuid('sess-1')),
      )
      expect(win.summaries.get(asUuid('leaf-a'))).toBe(
        full.summaries.get(asUuid('leaf-a')),
      )
    }
  })

  test('repeated windowed loads are idempotent', async () => {
    const full = await loadTranscriptFile(sessionFile)
    const mostRecentLeaf = findLatestMessage(
      full.messages.values(),
      m => full.leafUuids.has(m.uuid) && m.type === 'assistant',
    )
    const chain = buildConversationChain(full.messages, mostRecentLeaf!)
    const tailUuids = new Set(chain.slice(-10).map(m => m.uuid))
    const native = simulatedNative(buildFixture(), tailUuids)

    let first: string[] | null = null
    for (let round = 0; round < 10; round++) {
      const win = await loadTranscriptFile(sessionFile, {
        nativeWindow: {
          tailLines: native.tailLines,
          metaLines: native.metaLines,
        },
      })
      const ids: string[] = [...win.messages.keys()].map(String).sort()
      if (first === null) first = ids
      expect(ids).toEqual(first)
    }
  })
})
