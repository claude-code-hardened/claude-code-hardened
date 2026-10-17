import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/debug.ts', debugMock)

import { isPromptTooLongMessage } from '../errors.js'

function apiErrorWithText(text: string) {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as Parameters<typeof isPromptTooLongMessage>[0]
}

function normalMessage(text: string) {
  return {
    type: 'assistant',
    isApiErrorMessage: false,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as Parameters<typeof isPromptTooLongMessage>[0]
}

describe('isPromptTooLongMessage', () => {
  test('Anthropic shape still matches (case-insensitive substring, official jjn)', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText('Prompt is too long: 137500 tokens > 135000 maximum'),
      ),
    ).toBe(true)
    expect(
      isPromptTooLongMessage(
        apiErrorWithText('400 - prompt is too long: 270000 > 262144'),
      ),
    ).toBe(true)
  })

  test('Vertex/Gemini family: input is too long for requested model (official pair)', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText('input is too long for requested model'),
      ),
    ).toBe(true)
    expect(
      isPromptTooLongMessage(
        apiErrorWithText('Input is too long for requested model'),
      ),
    ).toBe(true)
  })

  test('OpenAI-compatible relays: maximum context length', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText(
          "Error 400: This model's maximum context length is 262144 tokens. However, you requested 270000 tokens",
        ),
      ),
    ).toBe(true)
  })

  test('OpenAI error type context_length_exceeded', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText(
          '{"error":{"code":"context_length_exceeded","message":"input too large"}}',
        ),
      ),
    ).toBe(true)
  })

  test('Chinese relay phrasing matches', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText('输入上下文长度超出模型限制，请减少输入'),
      ),
    ).toBe(true)
    expect(
      isPromptTooLongMessage(
        apiErrorWithText('请求失败：文本长度超过上下文长度上限'),
      ),
    ).toBe(true)
  })

  test('Gemini phrasing: input token count exceeds maximum', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText(
          'Gemini API stream request failed: 400 - The input token count (270000) exceeds the maximum number of tokens allowed (262144).',
        ),
      ),
    ).toBe(true)
  })

  test('wrapped SDK envelopes still match (substring pass)', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText(
          'Gemini API stream request failed: 400 - maximum context length exceeded',
        ),
      ),
    ).toBe(true)
  })

  test('other API errors do not match', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorWithText('Error 500: internal server error'),
      ),
    ).toBe(false)
    expect(
      isPromptTooLongMessage(apiErrorWithText('Error 401: unauthorized token')),
    ).toBe(false)
  })

  test('non-Error assistant messages never match', () => {
    expect(isPromptTooLongMessage(normalMessage('Prompt is too long'))).toBe(
      false,
    )
  })
})
