/**
 * Tests for the attribution cache sweep path restored in work package 2.5/2.7:
 * - commitAttribution owns the file-content cache body (official attribution
 *   module state singleton: `fileContentCache: new Map` — see
 *   docs/reverse-284/decompiled/0054-chunk-dxsxk16b/module-004-uncategorized.js:923)
 * - attributionHooks forwards sweep/clear to it and guards hook registration
 * - attributionTrailer.buildPRTrailers / postCommitAttribution.
 *   installPrepareCommitMsgHook stay documented no-ops (official semantics
 *   unrecoverable; they affect user-visible commit messages)
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readdirSync } from 'fs'
import { join } from 'path'
import { debugMock } from '../../../tests/mocks/debug'
import { logMock } from '../../../tests/mocks/log'

// Cut the bootstrap/state.ts side-effect chain pulled in by commitAttribution
// via log.ts/debug.ts (shared mocks — see tests/mocks/README or CLAUDE.md).
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)
// commitAttribution → model/model.ts → modelCost.ts imports logEvent from
// src/services/analytics/index.js, whose firstPartyEventLogger pulls the
// @opentelemetry stack. Stub it (same pattern as launchAutofixPr.test.ts).
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: () => Promise.resolve(),
  _resetForTesting: () => {},
  attachAnalyticsSink: () => {},
  stripProtoFields: (v: unknown) => v,
}))

const {
  createEmptyAttributionState,
  trackFileModification,
  trackFileDeletion,
  trackBulkFileChanges,
  getFileContentCacheStats,
  sweepFileContentCache,
  clearAttributionCaches,
} = await import('src/utils/commitAttribution.js')

const {
  registerAttributionHooks,
  isAttributionHooksRegistered,
  sweepFileContentCache: hooksSweepFileContentCache,
  clearAttributionCaches: hooksClearAttributionCaches,
} = await import('src/utils/attributionHooks.js')

const { buildPRTrailers } = await import('src/utils/attributionTrailer.js')
const { installPrepareCommitMsgHook } = await import(
  'src/utils/postCommitAttribution.js'
)

function stats(): { entries: number; bytes: number } {
  return getFileContentCacheStats()
}

beforeEach(() => {
  sweepFileContentCache()
})

describe('commitAttribution fileContentCache write-through', () => {
  test('tracks the latest content per file path', () => {
    const state = createEmptyAttributionState()
    trackFileModification(state, 'src/a.ts', 'old', 'aaaa', false)
    trackFileModification(state, 'src/a.ts', 'aaaa', 'bb', false)
    const after = stats()
    expect(after.entries).toBe(1)
    // Only the latest content body is cached: Buffer.byteLength('bb') === 2
    expect(after.bytes).toBe(2)
  })

  test('tracks distinct files as distinct entries', () => {
    const state = createEmptyAttributionState()
    trackFileModification(state, 'src/a.ts', '', 'aaa', false)
    trackFileModification(state, 'src/b.ts', '', 'bb', false)
    expect(stats().entries).toBe(2)
    expect(stats().bytes).toBe(5)
  })

  test('tracked deletion drops the cached entry', () => {
    const state = createEmptyAttributionState()
    trackFileModification(state, 'src/a.ts', 'old', 'content', false)
    expect(stats().entries).toBe(1)
    trackFileDeletion(state, 'src/a.ts', 'content')
    expect(stats().entries).toBe(0)
    expect(stats().bytes).toBe(0)
  })

  test('full-content modification (empty new content) drops the entry', () => {
    const state = createEmptyAttributionState()
    trackFileModification(state, 'src/a.ts', 'old', 'content', false)
    expect(stats().entries).toBe(1)
    trackFileModification(state, 'src/a.ts', 'content', '', false)
    expect(stats().entries).toBe(0)
  })

  test('entry count is capped at 100 (evicts oldest)', () => {
    const state = createEmptyAttributionState()
    for (let i = 0; i < 102; i++) {
      trackFileModification(
        state,
        `src/bulk/f${i}.ts`,
        '',
        `content-${i}`,
        false,
      )
    }
    const after = stats()
    expect(after.entries).toBe(100)
    // bytes = sum of the 100 most recent entries (content-2 .. content-101)
    let expected = 0
    for (let i = 2; i < 102; i++) {
      expected += Buffer.byteLength(`content-${i}`, 'utf8')
    }
    expect(after.bytes).toBe(expected)
  })

  test('single oversized content is not cached', () => {
    const state = createEmptyAttributionState()
    const huge = 'x'.repeat(26 * 1024 * 1024) // 26 MiB > 25 MiB cap
    trackFileModification(state, 'src/huge.ts', '', huge, false)
    expect(stats().entries).toBe(0)
    expect(stats().bytes).toBe(0)
  })

  test('bulk changes record modifications and drop deletions', () => {
    const state = createEmptyAttributionState()
    trackBulkFileChanges(state, [
      { path: 'src/x.ts', type: 'created', oldContent: '', newContent: 'xxx' },
      { path: 'src/y.ts', type: 'created', oldContent: '', newContent: 'yy' },
      {
        path: 'src/z.ts',
        type: 'deleted',
        oldContent: 'zzz',
        newContent: '',
      },
    ])
    expect(stats().entries).toBe(2)
    expect(stats().bytes).toBe(5)
  })
})

describe('sweepFileContentCache', () => {
  test('releases all cached file content after compaction', () => {
    const state = createEmptyAttributionState()
    trackFileModification(state, 'src/a.ts', '', 'aaaa', false)
    trackFileModification(state, 'src/b.ts', '', 'bb', false)
    expect(stats().entries).toBe(2)

    sweepFileContentCache()

    const after = stats()
    expect(after.entries).toBe(0)
    expect(after.bytes).toBe(0)
  })

  test('is a safe no-op on an empty cache', () => {
    sweepFileContentCache()
    expect(stats().entries).toBe(0)
  })

  test('hooks sweep forwards to the real body', () => {
    const state = createEmptyAttributionState()
    trackFileModification(state, 'src/a.ts', '', 'aaaa', false)
    expect(stats().entries).toBe(1)
    // The consumer chain (postCompactCleanup) calls the re-exported binding.
    expect(hooksSweepFileContentCache).toBe(sweepFileContentCache)
    hooksSweepFileContentCache()
    expect(stats().entries).toBe(0)
  })
})

describe('clearAttributionCaches', () => {
  test('drains the file-content cache on /clear', () => {
    const state = createEmptyAttributionState()
    trackFileModification(state, 'src/a.ts', '', 'aaaa', false)
    expect(stats().entries).toBe(1)

    clearAttributionCaches()

    expect(stats().entries).toBe(0)
    expect(stats().bytes).toBe(0)
  })

  test('hooks clear forwards to the real body', () => {
    expect(hooksClearAttributionCaches).toBe(clearAttributionCaches)
  })
})

describe('registerAttributionHooks', () => {
  test('is idempotent', () => {
    registerAttributionHooks()
    expect(isAttributionHooksRegistered()).toBe(true)
    // Second call is a no-op and must not throw.
    registerAttributionHooks()
    expect(isAttributionHooksRegistered()).toBe(true)
  })
})

describe('buildPRTrailers (documented stub)', () => {
  test('returns no trailers — official semantics pending', () => {
    const attributionData = {
      version: 1 as const,
      summary: {
        claudePercent: 93,
        claudeChars: 930,
        humanChars: 70,
        surfaces: ['cli'],
      },
      files: {},
      surfaceBreakdown: {},
      excludedGenerated: [],
      sessions: ['session-1'],
    }
    const trailers = buildPRTrailers(
      attributionData,
      createEmptyAttributionState(),
    )
    expect(trailers).toEqual([])
  })
})

describe('installPrepareCommitMsgHook (documented stub)', () => {
  test('resolves without writing any hook files', async () => {
    const tmpRoot = join(import.meta.dir, 'tmp-attribution-hook-check')
    await installPrepareCommitMsgHook(tmpRoot)
    let listing: string[] = []
    try {
      listing = readdirSync(tmpRoot)
    } catch {
      // Directory not created — also acceptable (no side effects at all).
    }
    expect(listing).toEqual([])
  })
})
