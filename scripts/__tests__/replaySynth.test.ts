import { describe, expect, test } from 'bun:test'
import {
  buildPayload,
  createReplaySynthesizer,
  type ReplaySynthConfig,
  mulberry32,
  VIRTUAL_FILE_INITIAL,
} from '../lib/replaySynth.ts'

function makeConfig(
  overrides: Partial<ReplaySynthConfig> = {},
): ReplaySynthConfig {
  return {
    messages: 120,
    seed: 42,
    ratios: { short: 6, toolPair: 3, edit: 1 },
    payloadMinBytes: 100 * 1024,
    payloadMaxBytes: 2048 * 1024,
    compactEvery: 50,
    compactKeepMessages: 40,
    ...overrides,
  }
}

describe('createReplaySynthesizer', () => {
  test('same seed + config produces a byte-identical plan', () => {
    const cfg = makeConfig()
    const a = createReplaySynthesizer(cfg)
    const b = createReplaySynthesizer(cfg)
    expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan))
    expect(a.stats).toEqual(b.stats)
    expect(a.virtualFileAfter(5, 'src/generated/module-5.ts')).toBe(
      b.virtualFileAfter(5, 'src/generated/module-5.ts'),
    )
  })

  test('different seed produces a different plan', () => {
    const a = createReplaySynthesizer(makeConfig())
    const b = createReplaySynthesizer(makeConfig({ seed: 43 }))
    expect(JSON.stringify(a.plan)).not.toBe(JSON.stringify(b.plan))
  })

  test('all-short config: exact round/message counts (2 msgs per round)', () => {
    const { plan, stats } = createReplaySynthesizer(
      makeConfig({
        messages: 10,
        ratios: { short: 1, toolPair: 0, edit: 0 },
        compactEvery: 0,
      }),
    )
    expect(plan.length).toBe(5)
    expect(stats.totalMessages).toBe(10)
    expect(stats.compactCount).toBe(0)
    expect(plan.every(round => round.kind === 'short')).toBe(true)
  })

  test('odd message target overshoots by at most one short round', () => {
    const { plan, stats } = createReplaySynthesizer(
      makeConfig({
        messages: 11,
        ratios: { short: 1, toolPair: 0, edit: 0 },
        compactEvery: 0,
      }),
    )
    expect(plan.length).toBe(6)
    expect(stats.totalMessages).toBe(12)
    expect(stats.totalMessages).toBeLessThan(11 + 2 + 1)
  })

  test('tool-pair-only config: 4 msgs per round, payload sizes within bounds', () => {
    const min = 1024
    const max = 2048
    const { plan, stats } = createReplaySynthesizer(
      makeConfig({
        messages: 12,
        ratios: { short: 0, toolPair: 1, edit: 0 },
        payloadMinBytes: min,
        payloadMaxBytes: max,
        compactEvery: 0,
      }),
    )
    expect(plan.length).toBe(3)
    expect(stats.totalMessages).toBe(12)
    let payloadSum = 0
    for (const round of plan) {
      expect(round.kind).toBe('tool_pair')
      expect(round.payloadSize).toBeDefined()
      expect(round.payloadSize!).toBeGreaterThanOrEqual(min)
      expect(round.payloadSize!).toBeLessThanOrEqual(max)
      payloadSum += round.payloadSize!
    }
    expect(stats.payloadBytes).toBe(payloadSum)
  })

  test('payload size distribution stays inside the min/max window', () => {
    const min = 100 * 1024
    const max = 2048 * 1024
    const { plan } = createReplaySynthesizer(
      makeConfig({
        ratios: { short: 0, toolPair: 1, edit: 0 },
        payloadMinBytes: min,
        payloadMaxBytes: max,
        compactEvery: 0,
      }),
    )
    expect(plan.length).toBeGreaterThan(10)
    for (const round of plan) {
      expect(round.payloadSize).toBeGreaterThanOrEqual(min)
      expect(round.payloadSize).toBeLessThanOrEqual(max)
    }
  })

  test('round-kind ratios reproduce the configured proportions', () => {
    // Deterministic seed, large enough sample: 2:1:1 weights → short ≈ 1/2
    // of rounds. Loose bands keep the test exact-output agnostic.
    const { plan } = createReplaySynthesizer(
      makeConfig({
        messages: 1200,
        ratios: { short: 2, toolPair: 1, edit: 1 },
        compactEvery: 0,
      }),
    )
    const kinds = { short: 0, tool_pair: 0, edit: 0 } as Record<string, number>
    for (const round of plan) kinds[round.kind] = (kinds[round.kind] ?? 0) + 1
    const total = plan.length
    expect(total).toBeGreaterThan(200)
    expect(kinds.short! / total).toBeGreaterThan(0.35)
    expect(kinds.short! / total).toBeLessThan(0.65)
    expect(kinds.tool_pair! / total).toBeGreaterThan(0.1)
    expect(kinds.edit! / total).toBeGreaterThan(0.1)
  })

  test('all-zero ratios fall back to short rounds', () => {
    const { plan } = createReplaySynthesizer(
      makeConfig({
        messages: 6,
        ratios: { short: 0, toolPair: 0, edit: 0 },
        compactEvery: 0,
      }),
    )
    expect(plan.length).toBe(3)
    expect(plan.every(round => round.kind === 'short')).toBe(true)
  })

  test('compact boundaries fire every Nth round, never on the final round', () => {
    // Hand-traced with all-short (2 msgs/round): boundaries at rounds 3 and 6;
    // round 9 drops its boundary because 18+2+1 is not < 20 target.
    const { plan, stats } = createReplaySynthesizer(
      makeConfig({
        messages: 20,
        ratios: { short: 1, toolPair: 0, edit: 0 },
        compactEvery: 3,
        compactKeepMessages: 40,
      }),
    )
    expect(stats.rounds).toBe(9)
    expect(stats.totalMessages).toBe(20)
    expect(stats.compactCount).toBe(2)
    const boundaryIndexes = plan
      .filter(round => round.compactBoundary)
      .map(round => round.index)
    expect(boundaryIndexes).toEqual([3, 6])
    expect(plan[plan.length - 1]?.compactBoundary).toBe(false)
  })

  test('edit rounds produce patches and build virtual files chronologically', () => {
    const { plan, stats, virtualFileAfter } = createReplaySynthesizer(
      makeConfig({
        messages: 8,
        ratios: { short: 0, toolPair: 0, edit: 1 },
        compactEvery: 0,
      }),
    )
    expect(plan.length).toBe(2)
    let editSum = 0
    for (const round of plan) {
      expect(round.kind).toBe('edit')
      expect(round.oldString).toBeDefined()
      expect(round.newString).toBeDefined()
      expect(round.newString!.length).toBeGreaterThan(round.oldString!.length)
      expect(round.newString).toContain(`// replay-edit r${round.index}`)
      editSum += (round.oldString!.length + round.newString!.length) * 2
    }
    expect(stats.editBytes).toBe(editSum)

    const file = plan[0]!.file
    // Before any edit round the file is pure seed content.
    expect(virtualFileAfter(0, file)).toBe(VIRTUAL_FILE_INITIAL(file))
    // After round 1 the round-1 patch text has been appended.
    expect(virtualFileAfter(1, file)).toContain('// replay-edit r1')
    // Deterministic across synthesizer instances.
    const other = createReplaySynthesizer(
      makeConfig({
        messages: 8,
        ratios: { short: 0, toolPair: 0, edit: 1 },
        compactEvery: 0,
      }),
    )
    expect(other.virtualFileAfter(1, file)).toBe(virtualFileAfter(1, file))
  })
})

describe('buildPayload', () => {
  test('yields EXACTLY the requested byte length', () => {
    for (const size of [1, 64, 4096, 100 * 1024, 123_457]) {
      expect(buildPayload('tag', size).length).toBe(size)
    }
  })

  test('is deterministic and embeds the unique tag', () => {
    expect(buildPayload('u1', 4096)).toBe(buildPayload('u1', 4096))
    expect(buildPayload('u1', 4096).startsWith('PAYLOAD u1 bytes=4096 ')).toBe(
      true,
    )
    expect(buildPayload('u2', 4096)).not.toBe(buildPayload('u1', 4096))
  })
})

describe('mulberry32 PRNG', () => {
  test('same seed → identical sequence, different seed → different', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    const seqA = [a(), a(), a()]
    expect(seqA).toEqual([b(), b(), b()])
    const c = mulberry32(8)
    expect([c(), c(), c()]).not.toEqual(seqA)
  })
})
