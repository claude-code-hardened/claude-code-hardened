import { describe, expect, test } from 'bun:test'
import {
  buildSummary,
  emptyAttributionState,
  formatSummary,
  fnv1aHex,
  type MemSample,
  olsSlope,
  parseCliOptions,
  REPLAY_READ_TOOL,
  SAMPLE_FILE,
  SUMMARY_FILE,
  usage,
  WARMUP_MESSAGES,
} from '../memory-replay.ts'

const MB = 1024 * 1024

function mem(rss: number, heapUsed: number): MemSample {
  return {
    rss,
    heapUsed,
    heapTotal: 128 * MB,
    external: 4 * MB,
    arrayBuffers: 2 * MB,
  }
}

describe('parseCliOptions', () => {
  test('returns documented defaults on empty argv', () => {
    expect(parseCliOptions([])).toEqual({
      messages: 10_000,
      out: '/tmp/memrun',
      seed: 42,
      heapdumpEvery: 0,
      gcEvery: 25,
      compactEvery: 50,
      compactKeep: 40,
      payloadMinBytes: 100 * 1024,
      payloadMaxBytes: 2048 * 1024,
      ratios: { short: 6, toolPair: 3, edit: 1 },
      maxTurns: 6,
      profile: false,
    })
  })

  test('parses every documented flag', () => {
    expect(
      parseCliOptions([
        '--messages',
        '50',
        '--out',
        '/tmp/memsmoke',
        '--seed',
        '7',
        '--heapdump',
        '100',
        '--gc-every',
        '5',
        '--compact-every',
        '10',
        '--compact-keep',
        '8',
        '--payload-min-kb',
        '200',
        '--payload-max-kb',
        '512',
        '--ratio',
        '2:1:1',
        '--max-turns',
        '3',
        '--profile',
      ]),
    ).toEqual({
      messages: 50,
      out: '/tmp/memsmoke',
      seed: 7,
      heapdumpEvery: 100,
      gcEvery: 5,
      compactEvery: 10,
      compactKeep: 8,
      payloadMinBytes: 200 * 1024,
      payloadMaxBytes: 512 * 1024,
      ratios: { short: 2, toolPair: 1, edit: 1 },
      maxTurns: 3,
      profile: true,
    })
  })

  test('--profile and zero-value flags are honored', () => {
    expect(parseCliOptions(['--profile'])?.profile).toBe(true)
    expect(parseCliOptions(['--heapdump', '0'])?.heapdumpEvery).toBe(0)
    expect(parseCliOptions(['--gc-every', '0'])?.gcEvery).toBe(0)
  })

  test('rejects unknown flags and stray positionals', () => {
    expect(parseCliOptions(['--bogus'])).toBeNull()
    expect(parseCliOptions(['50'])).toBeNull()
  })

  test('rejects out-of-range values', () => {
    expect(parseCliOptions(['--messages', '0'])).toBeNull()
    expect(parseCliOptions(['--messages', '-5'])).toBeNull()
    expect(parseCliOptions(['--max-turns', '0'])).toBeNull()
    expect(
      parseCliOptions(['--payload-min-kb', '3000', '--payload-max-kb', '100']),
    ).toBeNull()
  })

  test('rejects malformed --ratio values (and a missing one)', () => {
    expect(parseCliOptions(['--ratio'])).toBeNull()
    expect(parseCliOptions(['--ratio', '1:2'])).toBeNull()
    expect(parseCliOptions(['--ratio', '1:x:3'])).toBeNull()
  })

  test('--help / -h print usage (null result)', () => {
    expect(parseCliOptions(['--help'])).toBeNull()
    expect(parseCliOptions(['-h'])).toBeNull()
  })

  test('missing numeric value falls back to the documented default', () => {
    // Lenient by design: `--messages` with no number keeps 10000.
    expect(parseCliOptions(['--messages'])?.messages).toBe(10_000)
  })
})

describe('usage', () => {
  test('lists the documented flags', () => {
    const text = usage()
    expect(text).toContain('--messages')
    expect(text).toContain('--ratio')
    expect(text).toContain('--payload-min-kb')
    expect(text).toContain('bun scripts/memory-replay.ts')
  })
})

describe('olsSlope', () => {
  test('exact slope on a clean line', () => {
    expect(
      olsSlope([
        [0, 0],
        [1, 10],
        [2, 20],
      ]),
    ).toBe(10)
  })

  test('degenerate inputs return 0', () => {
    expect(olsSlope([])).toBe(0)
    expect(olsSlope([[0, 5]])).toBe(0)
    // Vertical line: zero denominator.
    expect(
      olsSlope([
        [3, 7],
        [3, 9],
      ]),
    ).toBe(0)
  })
})

describe('fnv1aHex', () => {
  test('matches known FNV-1a 32-bit test vectors', () => {
    expect(fnv1aHex('')).toBe('811c9dc5')
    expect(fnv1aHex('a')).toBe('e40c292c')
  })

  test('always returns 8 hex chars', () => {
    expect(fnv1aHex('src/generated/module-7.ts')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('buildSummary', () => {
  const baseOptions = parseCliOptions([])!
  const baseStats = {
    rounds: 25,
    syntheticMessages: 1000,
    durationMs: 20_000,
    compactCount: 1,
    payloadBytes: 12 * MB,
    editBytes: 3 * MB,
    attributionFiles: 4,
    roundKinds: { short: 15, tool_pair: 8, edit: 2 },
  }

  test('live-heap-dominated RSS growth → JS-retainer verdict', () => {
    const summary = buildSummary({
      options: baseOptions,
      stats: baseStats,
      samples: [
        { ...mem(100 * MB, 10 * MB), tsSec: 0 },
        { ...mem(200 * MB, 20 * MB), tsSec: 10 },
      ],
      gcProbes: [
        {
          tsSec: 2,
          round: 5,
          pre: mem(300 * MB, 40 * MB),
          post: mem(90 * MB, 10 * MB),
          gcMs: 40,
        },
        {
          tsSec: 9,
          round: 10,
          pre: mem(350 * MB, 60 * MB),
          post: mem(100 * MB, 18 * MB),
          gcMs: 45,
        },
      ],
      heapdumpFiles: ['/tmp/memrun/snapshot.heapsnapshot'],
    })
    expect(summary.rss.startMB).toBe(100)
    expect(summary.rss.endMB).toBe(200)
    expect(summary.rss.deltaMB).toBe(100)
    expect(summary.rss.slopeBytesPerSec).toBeCloseTo(10 * MB, 0)
    expect(summary.rss.per1kMessagesMB).toBeCloseTo(100, 5)
    expect(summary.heapUsed.deltaMB).toBe(10)
    // post-GC: live heap 10→18MB (+8), RSS 90→100MB (+10) → 80% share.
    expect(summary.postGc.probes).toBe(2)
    expect(summary.postGc.liveHeapDeltaMB).toBe(8)
    expect(summary.postGc.rssDeltaMB).toBe(10)
    expect(summary.postGc.cumulativeReclaimedMB).toBeCloseTo(72, 5)
    expect(summary.liveHeapShareOfRssGrowth).toBeCloseTo(0.8, 5)
    expect(summary.verdict).toContain('JS live heap dominates')
    expect(summary.config.messagesTarget).toBe(10_000)
    expect(summary.heapdump).toEqual(['/tmp/memrun/snapshot.heapsnapshot'])
  })

  test('partial share → mixed verdict', () => {
    const summary = buildSummary({
      options: baseOptions,
      stats: baseStats,
      samples: [
        { ...mem(100 * MB, 10 * MB), tsSec: 0 },
        { ...mem(110 * MB, 12 * MB), tsSec: 10 },
      ],
      gcProbes: [
        {
          tsSec: 2,
          round: 5,
          pre: mem(300 * MB, 40 * MB),
          post: mem(90 * MB, 6 * MB),
          gcMs: 40,
        },
        {
          tsSec: 9,
          round: 10,
          pre: mem(350 * MB, 60 * MB),
          post: mem(100 * MB, 10 * MB),
          gcMs: 45,
        },
      ],
      heapdumpFiles: [],
    })
    // Live heap +4MB vs post-GC RSS +10MB → 40% share.
    expect(summary.liveHeapShareOfRssGrowth).toBeCloseTo(0.4, 5)
    expect(summary.verdict).toContain('Mixed attribution')
  })

  test('flat post-GC heap with rising RSS → allocator-retention verdict', () => {
    const summary = buildSummary({
      options: baseOptions,
      stats: baseStats,
      samples: [
        { ...mem(100 * MB, 10 * MB), tsSec: 0 },
        { ...mem(200 * MB, 12 * MB), tsSec: 10 },
      ],
      gcProbes: [
        {
          tsSec: 2,
          round: 5,
          pre: mem(300 * MB, 40 * MB),
          post: mem(90 * MB, 8 * MB),
          gcMs: 40,
        },
        {
          tsSec: 9,
          round: 10,
          pre: mem(350 * MB, 60 * MB),
          post: mem(100 * MB, 8 * MB),
          gcMs: 45,
        },
      ],
      heapdumpFiles: [],
    })
    expect(summary.postGc.liveHeapDeltaMB).toBe(0)
    expect(summary.postGc.rssDeltaMB).toBe(10)
    expect(summary.verdict).toContain('Allocator retention')
  })

  test('empty samples/probes degrade to zeros instead of NaN', () => {
    const summary = buildSummary({
      options: baseOptions,
      stats: { ...baseStats, syntheticMessages: 0 },
      samples: [],
      gcProbes: [],
      heapdumpFiles: [],
    })
    expect(summary.rss.deltaMB).toBe(0)
    expect(summary.rss.per1kMessagesMB).toBe(0)
    expect(summary.postGc.probes).toBe(0)
    expect(Number.isFinite(summary.liveHeapShareOfRssGrowth)).toBe(true)
    expect(summary.verdict).toContain('Allocator retention')
  })
})

describe('formatSummary', () => {
  test('renders the attribution table', () => {
    const summary = buildSummary({
      options: parseCliOptions([])!,
      stats: {
        rounds: 2,
        syntheticMessages: 8,
        durationMs: 4_000,
        compactCount: 0,
        payloadBytes: 1024,
        editBytes: 0,
        attributionFiles: 1,
        roundKinds: { short: 2 },
      },
      samples: [
        { ...mem(90 * MB, 8 * MB), tsSec: 0 },
        { ...mem(100 * MB, 9 * MB), tsSec: 5 },
      ],
      gcProbes: [],
      heapdumpFiles: [],
    })
    const text = formatSummary(summary)
    expect(text).toContain('== memory replay attribution')
    expect(text).toContain('rounds=2')
    expect(text).toContain('syntheticMessages=8')
    expect(text).toContain('gc probes=0')
    expect(text).toContain('live-heap share of RSS growth:')
    expect(text).toContain('verdict:')
  })
})

describe('exported constants', () => {
  test('expose the stable contract used by the CLI and outputs', () => {
    expect(WARMUP_MESSAGES).toBe(2)
    expect(SAMPLE_FILE).toBe('samples.jsonl')
    expect(SUMMARY_FILE).toBe('summary.json')
    expect(REPLAY_READ_TOOL).toBe('ReplayRead')
  })
})

describe('emptyAttributionState', () => {
  test('starts with empty per-file maps and a replay surface', () => {
    const state = emptyAttributionState()
    expect(state.surface).toBe('replay')
    expect(state.fileStates).toBeInstanceOf(Map)
    expect(state.fileStates.size).toBe(0)
    expect(state.sessionBaselines.size).toBe(0)
    expect(state.startingHeadSha).toBeNull()
    expect(state.promptCount).toBe(0)
    expect(state.escapeCount).toBe(0)
  })
})
