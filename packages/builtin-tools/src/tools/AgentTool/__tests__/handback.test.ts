/**
 * 4.1 handback protocol — unit tests for the pure payload path.
 *
 * handback.ts is pure (zod + lazySchema only), so no mocks are needed.
 * Covers: payload schema validation, report formatting, the per-agent
 * handback registry, and the stream boundary predicates used by runAgent.
 *
 * Written for the 4.1 work package; verification commands are NOT run here
 * (write-only batch per task constraint).
 */
import { describe, expect, test } from 'bun:test'
import {
  HANDBACK_TOOL_NAME,
  collectHandbackToolUseIds,
  consumeHandback,
  formatHandbackReport,
  handbackPayloadSchema,
  isHandbackToolResult,
  recordHandback,
} from '../handback.js'

type StreamMessage = { type: string; message?: { content?: unknown } }
type Block = Record<string, unknown>

function assistantMessageWithToolUses(blocks: Block[]): StreamMessage {
  return {
    type: 'assistant',
    message: { content: blocks },
  }
}

function userMessageWithToolResults(blocks: Block[]): StreamMessage {
  return {
    type: 'user',
    message: { content: blocks },
  }
}

describe('handbackPayloadSchema', () => {
  test('accepts summary alone', () => {
    const parsed = handbackPayloadSchema().parse({
      summary: 'done with the refactor',
    })
    expect(parsed.summary).toBe('done with the refactor')
  })

  test('accepts the full free-form payload', () => {
    const parsed = handbackPayloadSchema().parse({
      summary: 'migrated the module',
      findings: ['api was duplicated', 'tests were stale'],
      files: ['src/a.ts', 'src/b.ts'],
      next_steps: ['run release checks'],
    })
    expect(parsed.findings?.length).toBe(2)
    expect(parsed.files?.length).toBe(2)
    expect(parsed.next_steps?.length).toBe(1)
  })

  test('rejects a missing or empty summary', () => {
    expect(() => handbackPayloadSchema().parse({})).toThrow()
    expect(() => handbackPayloadSchema().parse({ summary: '' })).toThrow()
  })

  test('rejects non-list optionals', () => {
    expect(() =>
      handbackPayloadSchema().parse({ summary: 'x', findings: 'oops' }),
    ).toThrow()
  })
})

describe('formatHandbackReport', () => {
  test('renders the required summary', () => {
    const report = formatHandbackReport({ summary: 'done' })
    expect(report).toContain('<handback>')
    expect(report).toContain('</handback>')
    expect(report).toContain('summary: done')
  })

  test('renders provided lists and omits absent ones', () => {
    const report = formatHandbackReport({
      summary: 's',
      findings: ['f1'],
      files: ['p1'],
      next_steps: ['n1'],
    })
    expect(report).toContain('findings:')
    expect(report).toContain('- f1')
    expect(report).toContain('files:')
    expect(report).toContain('- p1')
    expect(report).toContain('next_steps:')
    expect(report).toContain('- n1')
  })

  test('omits empty lists', () => {
    const report = formatHandbackReport({
      summary: 's',
      findings: [],
      files: [],
      next_steps: [],
    })
    expect(report).not.toContain('findings:')
    expect(report).not.toContain('files:')
    expect(report).not.toContain('next_steps:')
  })
})

describe('handback registry', () => {
  test('consumeHandback pops the recorded payload once per agent', () => {
    recordHandback('agent-hb-1', { summary: 'first' })
    expect(consumeHandback('agent-hb-1')).toEqual({ summary: 'first' })
    expect(consumeHandback('agent-hb-1')).toBeUndefined()
  })

  test('records are scoped per agent id', () => {
    recordHandback('agent-hb-2', { summary: 'a' })
    recordHandback('agent-hb-3', { summary: 'b' })
    expect(consumeHandback('agent-hb-3')).toEqual({ summary: 'b' })
    expect(consumeHandback('agent-hb-2')).toEqual({ summary: 'a' })
    expect(consumeHandback('agent-hb-2')).toBeUndefined()
    expect(consumeHandback('agent-hb-3')).toBeUndefined()
  })

  test('unrecorded agents consume nothing', () => {
    expect(consumeHandback('agent-hb-never')).toBeUndefined()
  })
})

describe('collectHandbackToolUseIds', () => {
  test('collects tool_use ids of Handback calls from assistant messages', () => {
    const ids = new Set<string>()
    const message = assistantMessageWithToolUses([
      { type: 'tool_use', id: 'tu_1', name: HANDBACK_TOOL_NAME, input: {} },
      { type: 'tool_use', id: 'tu_2', name: 'Other', input: {} },
    ])
    expect(collectHandbackToolUseIds(message, ids)).toBe(true)
    expect(ids.has('tu_1')).toBe(true)
    expect(ids.has('tu_2')).toBe(false)
  })

  test('ignores assistant messages without a Handback call', () => {
    const ids = new Set<string>()
    const message = assistantMessageWithToolUses([
      { type: 'tool_use', id: 'tu_3', name: 'Bash', input: {} },
    ])
    expect(collectHandbackToolUseIds(message, ids)).toBe(false)
    expect(ids.size).toBe(0)
  })

  test('ignores non-assistant messages', () => {
    const ids = new Set<string>()
    expect(collectHandbackToolUseIds(userMessageWithToolResults([]), ids)).toBe(
      false,
    )
  })
})

describe('isHandbackToolResult', () => {
  test('matches the tool_result of a tracked Handback tool_use id', () => {
    const ids = new Set(['tu_hb'])
    const message = userMessageWithToolResults([
      { type: 'tool_result', tool_use_id: 'tu_hb', content: 'ok' },
    ])
    expect(isHandbackToolResult(message, ids)).toBe(true)
  })

  test('does not match sibling tool results', () => {
    const ids = new Set(['tu_hb'])
    const message = userMessageWithToolResults([
      { type: 'tool_result', tool_use_id: 'tu_other', content: 'ok' },
    ])
    expect(isHandbackToolResult(message, ids)).toBe(false)
  })

  test('does not match when no handback was seen or on other message kinds', () => {
    const ids = new Set<string>()
    const message = userMessageWithToolResults([
      { type: 'tool_result', tool_use_id: 'tu_hb', content: 'ok' },
    ])
    expect(isHandbackToolResult(message, ids)).toBe(false)
    expect(
      isHandbackToolResult(
        assistantMessageWithToolUses([]),
        new Set(['tu_hb']),
      ),
    ).toBe(false)
  })
})
