import { describe, expect, mock, test } from 'bun:test'
import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js'

mock.module('src/utils/slowOperations.ts', () => ({
  jsonStringify: (value: unknown) => JSON.stringify(value),
}))
mock.module('src/utils/mcp/dateTimeParser.ts', () => ({
  looksLikeISO8601: (value: string) => /^\d{4}-\d{2}-\d{2}T/.test(value),
  parseNaturalLanguageDateTime: async () => ({
    success: false as const,
    error: 'natural language parsing unavailable in tests',
  }),
}))

import {
  validateElicitationInput,
  validateElicitationInputAsync,
} from '../elicitationValidation'

const dateTimeSchema: PrimitiveSchemaDefinition = {
  type: 'string',
  format: 'date-time',
}

describe('validateElicitationInput', () => {
  describe('date-time format', () => {
    test('accepts second-precision offset', () => {
      const result = validateElicitationInput(
        '2024-03-15T14:30:00+08:00',
        dateTimeSchema,
      )
      expect(result.isValid).toBe(true)
      expect(result.value).toBe('2024-03-15T14:30:00+08:00')
    })

    test('accepts second-precision UTC', () => {
      const result = validateElicitationInput(
        '2024-03-15T14:30:00Z',
        dateTimeSchema,
      )
      expect(result.isValid).toBe(true)
    })

    test('accepts minute-precision offset (zod 4.5 regression)', () => {
      const result = validateElicitationInput(
        '2024-03-15T14:30+08:00',
        dateTimeSchema,
      )
      expect(result.isValid).toBe(true)
      expect(result.value).toBe('2024-03-15T14:30+08:00')
    })

    test('accepts minute-precision UTC', () => {
      const result = validateElicitationInput(
        '2024-03-15T14:30Z',
        dateTimeSchema,
      )
      expect(result.isValid).toBe(true)
    })

    test('rejects local time without offset or Z', () => {
      const result = validateElicitationInput(
        '2024-03-15T14:30',
        dateTimeSchema,
      )
      expect(result.isValid).toBe(false)
    })

    test('rejects date-only input', () => {
      const result = validateElicitationInput('2024-03-15', dateTimeSchema)
      expect(result.isValid).toBe(false)
    })

    test('rejects non-date input', () => {
      const result = validateElicitationInput('not-a-date', dateTimeSchema)
      expect(result.isValid).toBe(false)
    })
  })

  describe('date-time with length constraints', () => {
    test('enforces minLength alongside the format check', () => {
      const result = validateElicitationInput('2024-03-15T14:30+08:00', {
        type: 'string',
        format: 'date-time',
        minLength: 30,
      })
      expect(result.isValid).toBe(false)
    })

    test('enforces maxLength alongside the format check', () => {
      const result = validateElicitationInput('2024-03-15T14:30Z', {
        type: 'string',
        format: 'date-time',
        maxLength: 10,
      })
      expect(result.isValid).toBe(false)
    })

    test('accepts input within length bounds', () => {
      const result = validateElicitationInput('2024-03-15T14:30+08:00', {
        type: 'string',
        format: 'date-time',
        minLength: 10,
        maxLength: 30,
      })
      expect(result.isValid).toBe(true)
    })
  })

  describe('other formats unaffected', () => {
    test('date format still accepts plain dates', () => {
      const result = validateElicitationInput('2024-03-15', {
        type: 'string',
        format: 'date',
      })
      expect(result.isValid).toBe(true)
    })

    test('email format still validates', () => {
      const valid = validateElicitationInput('user@example.com', {
        type: 'string',
        format: 'email',
      })
      expect(valid.isValid).toBe(true)
      const invalid = validateElicitationInput('nope', {
        type: 'string',
        format: 'email',
      })
      expect(invalid.isValid).toBe(false)
    })
  })
})

describe('validateElicitationInputAsync', () => {
  test('passes minute-precision ISO input through sync validation', async () => {
    const result = await validateElicitationInputAsync(
      '2024-03-15T14:30+08:00',
      dateTimeSchema,
      new AbortController().signal,
    )
    expect(result.isValid).toBe(true)
  })

  test('falls back to NL parsing for non-ISO input', async () => {
    const result = await validateElicitationInputAsync(
      'next Monday',
      dateTimeSchema,
      new AbortController().signal,
    )
    expect(result.isValid).toBe(false)
  })
})
