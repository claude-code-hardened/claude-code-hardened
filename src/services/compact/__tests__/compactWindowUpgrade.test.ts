import { describe, expect, test, beforeEach, mock } from 'bun:test'
import type { Message } from '../../../types/message.js'

// Resume windowing constant the production module reads from sessionStorage.
const RESUME_WINDOW = 500

// ---------------------------------------------------------------------------
// Mocks — resolved via compact.ts's own import specifiers. The storage layer
// is data source (not business logic), so mocking it here matches the repo's
// mock rules: mock the dependency, never the module under test.
// ---------------------------------------------------------------------------

let mockGetSessionId: () => string | null = () => 'sid-1'
let mockFullLog: { messages: unknown[] } | null = null
let lastGetLastSessionLogCalls = 0

mock.module('src/utils/sessionStorage.js', () => ({
  RESUME_WINDOW,
  getLastSessionLog: (sid: string) => {
    lastGetLastSessionLogCalls++
    void sid
    return Promise.resolve(mockFullLog)
  },
}))

mock.module('src/utils/conversationRecovery.js', () => ({
  deserializeMessages: (messages: unknown[]) => messages as Message[],
}))

let debugLines: string[] = []
mock.module('src/utils/debug.js', () => ({
  logForDebugging: (line: string) => {
    debugLines.push(line)
  },
}))

mock.module('@anthropic-ai/sdk', () => ({
  APIUserAbortError: class APIUserAbortError extends Error {},
}))

mock.module('lodash-es/uniqBy.js', () => ({
  default: (arr: unknown[]) => arr,
}))

mock.module('src/bootstrap/state.js', () => ({
  getSessionId: () => mockGetSessionId(),
  getInvokedSkillsForAgent: () => new Set(),
  markPostCompaction: () => {},
}))

// Import under test AFTER mocks are registered.
const { resolveCompactMessages } = await import('../compact.js')

// ---------------------------------------------------------------------------
// Fixtures: a windowed set of exactly RESUME_WINDOW messages, and a full
// chain that is strictly longer.
// ---------------------------------------------------------------------------

function makeMessage(i: number): Message {
  return {
    type: 'user',
    message: { role: 'user', content: `msg-${i}` },
    uuid: `u-${i}` as Message['uuid'],
    timestamp: '2026-09-19T00:00:00.000Z',
  } as Message
}

const windowedSet: Message[] = Array.from({ length: RESUME_WINDOW }, (_, i) =>
  makeMessage(i),
)

describe('resolveCompactMessages', () => {
  beforeEach(() => {
    debugLines = []
    lastGetLastSessionLogCalls = 0
    mockGetSessionId = () => 'sid-1'
  })

  test('T1: main thread at the cap + longer on-disk chain → upgraded to full chain', async () => {
    mockFullLog = {
      messages: Array.from({ length: RESUME_WINDOW + 1371 }, (_, i) => null),
    }
    const result = await resolveCompactMessages(windowedSet, undefined)
    expect(result.length).toBe(RESUME_WINDOW + 1371)
    expect(lastGetLastSessionLogCalls).toBe(1)
    expect(debugLines.some(l => l.includes('windowed chain upgraded'))).toBe(
      true,
    )
  })

  test('T2: below the cap → no reload, same reference returned', async () => {
    mockFullLog = { messages: [null, null] }
    const small = windowedSet.slice(0, 100)
    const result = await resolveCompactMessages(small, undefined)
    expect(result).toBe(small)
    expect(lastGetLastSessionLogCalls).toBe(0)
  })

  test('T3: sub-agent (agentId present) → never reloads', async () => {
    mockFullLog = {
      messages: Array.from({ length: RESUME_WINDOW + 500 }, () => null),
    }
    const result = await resolveCompactMessages(windowedSet, 'agent-7')
    expect(result).toBe(windowedSet)
    expect(lastGetLastSessionLogCalls).toBe(0)
  })

  test('T4: transcript unavailable → falls back to the windowed set, no throw', async () => {
    mockGetSessionId = () => null
    const result = await resolveCompactMessages(windowedSet, undefined)
    expect(result).toBe(windowedSet)
  })

  test('T4b: on-disk chain shorter than window → not replaced', async () => {
    mockFullLog = { messages: Array.from({ length: 10 }, () => null) }
    const result = await resolveCompactMessages(windowedSet, undefined)
    expect(result).toBe(windowedSet)
  })

  test('T5: exactly RESUME_WINDOW on disk → not replaced (must be strictly longer)', async () => {
    mockFullLog = {
      messages: Array.from({ length: RESUME_WINDOW }, () => null),
    }
    const result = await resolveCompactMessages(windowedSet, undefined)
    expect(result).toBe(windowedSet)
  })
})
