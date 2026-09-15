/**
 * Tests for unifiedSuggestions.ts — Fuse.js ordering snapshots.
 *
 * fuse.js was upgraded 7.3.0 → 7.5.0 (bug fixes #830/#831/#833/#835).
 * #833 normalizes key weights before exponentiating, which inflates scores
 * (~3.2x mean on the unified config per scripts/fuse-differential.ts) and
 * changes how Fuse-scored MCP/agent suggestions interleave with nucleo
 * file scores. These snapshots pin the post-upgrade ordering so any future
 * scoring change is caught. Threshold stays at 0.6 (bitap gate semantics
 * unchanged in 7.5 — candidate sets match the 7.3 baseline).
 *
 * Note: agent suggestions pass a substring pre-filter (`includes`) before
 * Fuse, so only pre-filter survivors are Fuse-scored and ordered.
 *
 * Expected orderings were derived from the differential harness
 * (scripts/fuse-differential.ts) running the exact repo Fuse config.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'

// unifiedSuggestions imports logError (log.ts → bootstrap/state side effects)
mock.module('src/utils/log.ts', logMock)
// File suggestions hit the filesystem (nucleo index); the Fuse-under-test
// only scores the non-file (MCP/agent) sources. Default impl returns [] to
// keep the snapshots deterministic in any working directory; the mixed
// interleaving suite below swaps in scenario files via `fileImpl`.
let fileImpl: (
  query: string,
  showOnEmpty?: boolean,
) => Promise<
  Array<{
    displayText: string
    description?: string
    metadata?: { score?: number }
  }>
> = async () => []
mock.module('src/hooks/fileSuggestions.js', () => ({
  generateFileSuggestions: (query: string, showOnEmpty?: boolean) =>
    fileImpl(query, showOnEmpty),
}))

const { generateUnifiedSuggestions } = await import('../unifiedSuggestions.js')

function makeAgent(agentType: string, whenToUse: string) {
  return {
    agentType,
    whenToUse,
    sourcePath: `/mock/agents/${agentType}.md`,
  } as unknown as Parameters<typeof generateUnifiedSuggestions>[2][number]
}

describe('generateUnifiedSuggestions (fuse.js 7.5 ordering snapshots)', () => {
  const agents = [
    makeAgent('sdd-planner', 'Create spec-driven development plans'),
    makeAgent('sdd-implementer', 'Implement spec-driven plans step by step'),
    makeAgent('sdd-verifier', 'Verify implementation against the spec'),
  ]

  test('narrows to the substring pre-filter match before Fuse scores', async () => {
    // generateAgentSuggestions pre-filters agents with a plain
    // `agentType/displayText.includes(query)` gate, so 'sdd-v' only ever
    // reaches Fuse for sdd-verifier — the fuzzy sibling agents are excluded
    // upstream of Fuse regardless of their Fuse scores.
    const results = await generateUnifiedSuggestions('sdd-v', {}, agents)
    expect(results.map(r => r.displayText)).toEqual(['sdd-verifier (agent)'])
  })

  test('orders pre-filter survivors by Fuse score (7.5 scale snapshot)', async () => {
    // 'age' passes the pre-filter for all three (it sits in the common
    // '(agent)' suffix), so the ordering is decided purely by Fuse scores:
    // displayText position + description matches under the 7.5 weight
    // normalization. Expected order (planner 0.712 < verifier 0.738 <
    // implementer 0.778) derived from scripts/fuse-differential.ts.
    const results = await generateUnifiedSuggestions('age', {}, agents)
    expect(results.map(r => r.displayText)).toEqual([
      'sdd-planner (agent)',
      'sdd-verifier (agent)',
      'sdd-implementer (agent)',
    ])
  })

  test('keeps tied candidates in stable index order', async () => {
    // 'sdd' prefix-matches all three agentTypes with identical scores;
    // 7.5's stable tie ordering must preserve the input order.
    const results = await generateUnifiedSuggestions('sdd', {}, agents)
    expect(results.slice(0, 3).map(r => r.displayText)).toEqual([
      'sdd-planner (agent)',
      'sdd-implementer (agent)',
      'sdd-verifier (agent)',
    ])
  })

  test('ranks MCP resources by name/description keys', async () => {
    const resources = {
      context7: [
        {
          uri: 'docs/fuse.js',
          name: 'fuse.js docs',
          description: 'fuse.js library documentation',
          server: 'context7',
        },
      ],
    }
    const results = await generateUnifiedSuggestions('fuse', resources, agents)
    // The resource matches 'fuse' on displayText/name/description; the
    // agents only match weakly through their descriptions.
    expect(results[0]!.displayText).toBe('context7:docs/fuse.js')
    expect(results[0]!.id).toBe('mcp-resource-context7__docs/fuse.js')
  })
})

describe('generateUnifiedSuggestions (mixed file+agent interleaving)', () => {
  // Unlike the snapshots above, the file side here is NOT mocked empty:
  // real pipelines interleave nucleo-scored file suggestions with
  // Fuse-scored agent suggestions by raw score (lower = better), where
  // files without a nucleo score default to 0.5. The orderings below were
  // captured from the real pipeline against fuse.js 7.5.0 and pin the
  // 7.5-scale interleaving. Agent Fuse scores for 'age' land ~0.22
  // (planner 0.2223 < implementer/verifier 0.2239, tie → stable input
  // order), so agents beat default-score files but lose to a strong
  // nucleo match and win against a weak one.
  const agents = [
    makeAgent('sdd-agent-planner', 'Create spec-driven agent plans'),
    makeAgent('sdd-agent-implementer', 'Implement spec-driven agent plans'),
    makeAgent('sdd-agent-verifier', 'Verify implementation agent plans'),
  ]

  function file(displayText: string, score?: number) {
    return score !== undefined
      ? { id: `file-${displayText}`, displayText, metadata: { score } }
      : { id: `file-${displayText}`, displayText }
  }

  afterEach(() => {
    fileImpl = async () => []
  })

  test('agents outrank files falling back to the default 0.5 score', async () => {
    // Both files miss the nucleo score → default 0.5 > agent ~0.22; the
    // two tied files keep their input order (stable sort).
    fileImpl = async () => [
      file('src/agents/manager.ts'),
      file('docs/agent-guide.md'),
    ]
    const results = await generateUnifiedSuggestions('age', {}, agents)
    expect(results.map(r => r.displayText)).toEqual([
      'sdd-agent-planner (agent)',
      'sdd-agent-implementer (agent)',
      'sdd-agent-verifier (agent)',
      'src/agents/manager.ts',
      'docs/agent-guide.md',
    ])
  })

  test('agents also outrank a poor nucleo file score of 0.9', async () => {
    fileImpl = async () => [file('src/agents/manager.ts', 0.9)]
    const results = await generateUnifiedSuggestions('age', {}, agents)
    expect(results.map(r => r.displayText)).toEqual([
      'sdd-agent-planner (agent)',
      'sdd-agent-implementer (agent)',
      'sdd-agent-verifier (agent)',
      'src/agents/manager.ts',
    ])
  })

  test('a strong nucleo file score of 0.15 outranks all agents', async () => {
    fileImpl = async () => [file('src/agents/manager.ts', 0.15)]
    const results = await generateUnifiedSuggestions('age', {}, agents)
    expect(results.map(r => r.displayText)).toEqual([
      'src/agents/manager.ts',
      'sdd-agent-planner (agent)',
      'sdd-agent-implementer (agent)',
      'sdd-agent-verifier (agent)',
    ])
  })

  test('mixed good/default/poor files interleave around the agent block', async () => {
    fileImpl = async () => [
      file('src/agents/manager.ts', 0.15),
      file('docs/agent-guide.md'),
      file('src/hooks/useAgentMode.ts', 0.9),
    ]
    const results = await generateUnifiedSuggestions('age', {}, agents)
    expect(results.map(r => r.displayText)).toEqual([
      'src/agents/manager.ts',
      'sdd-agent-planner (agent)',
      'sdd-agent-implementer (agent)',
      'sdd-agent-verifier (agent)',
      'docs/agent-guide.md',
      'src/hooks/useAgentMode.ts',
    ])
  })
})
