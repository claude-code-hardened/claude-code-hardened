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
import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'

// unifiedSuggestions imports logError (log.ts → bootstrap/state side effects)
mock.module('src/utils/log.ts', logMock)
// File suggestions hit the filesystem (nucleo index); the Fuse-under-test
// only scores the non-file (MCP/agent) sources. Returning [] keeps the
// snapshot deterministic in any working directory.
mock.module('src/hooks/fileSuggestions.js', () => ({
  generateFileSuggestions: async () => [],
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
