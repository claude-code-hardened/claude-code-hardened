/**
 * 4.1 subagent depth cap — unit tests for the pure depth helpers.
 *
 * subagentDepth.ts is dependency-free, so no mocks are needed (repo rule:
 * do not mock pure modules). Official reference:
 * docs/reverse-284/decompiled/0128-chunk-zrkp23rq/tools/agent.js
 *
 * Written for the 4.1 work package; verification commands are NOT run here
 * (write-only batch per task constraint).
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH,
  MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR,
  clearSubagentSpawnDepthsForTest,
  evaluateSubagentSpawnDepth,
  getMaxSubagentSpawnDepth,
  getRegisteredSubagentSpawnDepth,
  getSubagentSpawnDepth,
  isSubagentSpawnDepthAtCap,
  parseMaxSubagentSpawnDepth,
  registerSubagentSpawnDepth,
  subagentDepthCapError,
  unregisterSubagentSpawnDepth,
} from '../subagentDepth.js'

function envWith(
  value: string | undefined,
): Record<string, string | undefined> {
  return { [MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR]: value }
}

describe('parseMaxSubagentSpawnDepth', () => {
  test('accepts a positive whole number in plain digits', () => {
    expect(parseMaxSubagentSpawnDepth('5')).toBe(5)
    expect(parseMaxSubagentSpawnDepth('1')).toBe(1)
    expect(parseMaxSubagentSpawnDepth(' 3 ')).toBe(3)
  })

  test('ignores values that are not positive whole numbers (official: ignored)', () => {
    expect(parseMaxSubagentSpawnDepth('0')).toBeUndefined()
    expect(parseMaxSubagentSpawnDepth('-1')).toBeUndefined()
    expect(parseMaxSubagentSpawnDepth('3.5')).toBeUndefined()
    expect(parseMaxSubagentSpawnDepth('abc')).toBeUndefined()
    expect(parseMaxSubagentSpawnDepth('')).toBeUndefined()
    expect(parseMaxSubagentSpawnDepth('  ')).toBeUndefined()
    expect(parseMaxSubagentSpawnDepth('+2')).toBeUndefined()
  })

  test('undefined stays undefined and resolves at the getter', () => {
    expect(parseMaxSubagentSpawnDepth(undefined)).toBeUndefined()
  })
})

describe('getMaxSubagentSpawnDepth', () => {
  test('defaults to the official documented value (3) when unset', () => {
    expect(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH).toBe(3)
    expect(getMaxSubagentSpawnDepth({})).toBe(3)
    expect(getMaxSubagentSpawnDepth(envWith(undefined))).toBe(3)
  })

  test('honors a valid override', () => {
    expect(getMaxSubagentSpawnDepth(envWith('5'))).toBe(5)
    expect(getMaxSubagentSpawnDepth(envWith('1'))).toBe(1)
  })

  test('falls back to the default on invalid values', () => {
    expect(getMaxSubagentSpawnDepth(envWith('zero'))).toBe(3)
    expect(getMaxSubagentSpawnDepth(envWith('-2'))).toBe(3)
    expect(getMaxSubagentSpawnDepth(envWith('0'))).toBe(3)
  })
})

describe('subagent spawn depth registry', () => {
  test('registers, reads and unregisters agent depths', () => {
    clearSubagentSpawnDepthsForTest()
    registerSubagentSpawnDepth('agent-a', 2)
    expect(getRegisteredSubagentSpawnDepth('agent-a')).toBe(2)
    unregisterSubagentSpawnDepth('agent-a')
    expect(getRegisteredSubagentSpawnDepth('agent-a')).toBeUndefined()
    clearSubagentSpawnDepthsForTest()
  })
})

describe('getSubagentSpawnDepth', () => {
  test('main conversation (undefined agentId) is depth 0', () => {
    expect(getSubagentSpawnDepth(undefined)).toBe(0)
  })

  test('registered agent resolves its spawn depth', () => {
    clearSubagentSpawnDepthsForTest()
    registerSubagentSpawnDepth('agent-b', 2)
    expect(getSubagentSpawnDepth('agent-b')).toBe(2)
    clearSubagentSpawnDepthsForTest()
  })

  test('defined but unregistered agent is conservatively depth 1', () => {
    clearSubagentSpawnDepthsForTest()
    expect(getSubagentSpawnDepth('teammate-unregistered')).toBe(1)
  })
})

describe('isSubagentSpawnDepthAtCap', () => {
  test('spawner at max depth is capped (official: Tt >= kt)', () => {
    expect(isSubagentSpawnDepthAtCap(3, 3)).toBe(true)
    expect(isSubagentSpawnDepthAtCap(4, 3)).toBe(true)
  })

  test('spawner below the cap may spawn', () => {
    expect(isSubagentSpawnDepthAtCap(2, 3)).toBe(false)
    expect(isSubagentSpawnDepthAtCap(0, 3)).toBe(false)
  })
})

describe('evaluateSubagentSpawnDepth', () => {
  test('main thread can spawn below the default cap', () => {
    clearSubagentSpawnDepthsForTest()
    const evaluation = evaluateSubagentSpawnDepth({ agentId: undefined })
    expect(evaluation.currentDepth).toBe(0)
    expect(evaluation.nextDepth).toBe(1)
    expect(evaluation.maxDepth).toBe(3)
    expect(evaluation.allowed).toBe(true)
    clearSubagentSpawnDepthsForTest()
  })

  test('spawner at the cap is refused (official Tt>=kt semantics)', () => {
    clearSubagentSpawnDepthsForTest()
    registerSubagentSpawnDepth('agent-at-cap', 3)
    const evaluation = evaluateSubagentSpawnDepth({ agentId: 'agent-at-cap' })
    expect(evaluation.allowed).toBe(false)
    clearSubagentSpawnDepthsForTest()
  })

  test('env override lowers the cap and flips the decision', () => {
    clearSubagentSpawnDepthsForTest()
    registerSubagentSpawnDepth('agent-depth-1', 1)
    const defaultEval = evaluateSubagentSpawnDepth({ agentId: 'agent-depth-1' })
    expect(defaultEval.allowed).toBe(true)
    const strictEval = evaluateSubagentSpawnDepth({
      agentId: 'agent-depth-1',
      env: envWith('1'),
    })
    expect(strictEval.maxDepth).toBe(1)
    expect(strictEval.allowed).toBe(false)
    clearSubagentSpawnDepthsForTest()
  })
})

describe('subagentDepthCapError', () => {
  test('carries the current depth, the cap and the env var name', () => {
    const error = subagentDepthCapError(3, 3)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('depth 3 of 3')
    expect(error.message).toContain(MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR)
  })
})
