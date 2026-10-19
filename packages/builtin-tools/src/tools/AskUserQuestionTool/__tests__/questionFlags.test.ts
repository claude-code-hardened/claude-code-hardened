/**
 * Tests for the QUESTION env extensions — corrected per the R6 review round:
 * CLAUDE_CODE_QUESTION_EXTENDED widens the per-question FORM (kind face:
 * text/number with title/placeholder/min/max fields, official 0311 anchor),
 * it does NOT raise the question count cap (the earlier 4→8 reading was a
 * fabrication). Optional-descriptions keeps its official toggle semantics.
 * Both switches are honored only on entrypoint-eligible (remote / SDK)
 * surfaces. Pure zod module, no mocks needed.
 */
import { describe, expect, test } from 'bun:test'

import {
  BASE_QUESTION_MAX,
  buildQuestionOptionSchema,
  buildQuestionSchema,
  getQuestionSchemaFlags,
  isQuestionEntrypointEligible,
  QUESTION_ENTRYPOINT_ENV,
  QUESTION_EXTENDED_ENV,
  QUESTION_OPTIONAL_DESCRIPTIONS_ENV,
} from '../questionFlags.js'

const BASE_FLAGS = { extended: false, optionalDescriptions: false }
const EXTENDED_FLAGS = { extended: true, optionalDescriptions: false }

function choiceQuestion() {
  return {
    question: 'Which library?',
    header: 'Library',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ],
    multiSelect: false,
  }
}

describe('isQuestionEntrypointEligible', () => {
  test('remote and sdk entrypoints are eligible', () => {
    expect(isQuestionEntrypointEligible('remote')).toBe(true)
    expect(isQuestionEntrypointEligible('sdk')).toBe(true)
    expect(isQuestionEntrypointEligible('sdk-1')).toBe(true)
  })

  test('plain cli and unknown entrypoints are not (official gate)', () => {
    expect(isQuestionEntrypointEligible('cli')).toBe(false)
    expect(isQuestionEntrypointEligible('vscode')).toBe(false)
    expect(isQuestionEntrypointEligible(undefined)).toBe(false)
    expect(isQuestionEntrypointEligible('')).toBe(false)
  })
})

describe('getQuestionSchemaFlags', () => {
  test('defaults off without env or eligible entrypoint', () => {
    expect(getQuestionSchemaFlags({})).toEqual({
      extended: false,
      optionalDescriptions: false,
    })
    expect(
      getQuestionSchemaFlags({
        [QUESTION_ENTRYPOINT_ENV]: 'cli',
        [QUESTION_EXTENDED_ENV]: '1',
        [QUESTION_OPTIONAL_DESCRIPTIONS_ENV]: '1',
      }),
    ).toEqual({ extended: false, optionalDescriptions: false })
  })

  test('honors the env switches only with an eligible entrypoint', () => {
    expect(
      getQuestionSchemaFlags({
        [QUESTION_ENTRYPOINT_ENV]: 'remote',
        [QUESTION_EXTENDED_ENV]: '1',
        [QUESTION_OPTIONAL_DESCRIPTIONS_ENV]: 'true',
      }),
    ).toEqual({ extended: true, optionalDescriptions: true })
  })

  test('falsy env values keep the base schema', () => {
    expect(
      getQuestionSchemaFlags({
        [QUESTION_ENTRYPOINT_ENV]: 'sdk-test',
        [QUESTION_EXTENDED_ENV]: '0',
        [QUESTION_OPTIONAL_DESCRIPTIONS_ENV]: 'no',
      }),
    ).toEqual({ extended: false, optionalDescriptions: false })
  })
})

describe('question count cap (R6 correction)', () => {
  test('the cap is 4 in BOTH modes — extended does not raise it', () => {
    expect(BASE_QUESTION_MAX).toBe(4)
  })
})

describe('buildQuestionOptionSchema', () => {
  test('default schema keeps description required (byte-identical base)', () => {
    const schema = buildQuestionOptionSchema(BASE_FLAGS)
    expect(schema.safeParse({ label: 'Option A' }).success).toBe(false)
    const parsed = schema.safeParse({
      label: 'Option A',
      description: 'why',
    })
    expect(parsed.success).toBe(true)
  })

  test('optionalDescriptions makes description omittable', () => {
    const schema = buildQuestionOptionSchema({
      ...BASE_FLAGS,
      optionalDescriptions: true,
    })
    expect(schema.safeParse({ label: 'Option A' }).success).toBe(true)
    expect(
      schema.safeParse({ label: 'Option A', description: 'why' }).success,
    ).toBe(true)
  })

  test('extended mode allows omitting the description (official W variant)', () => {
    const schema = buildQuestionOptionSchema(EXTENDED_FLAGS)
    expect(schema.safeParse({ label: 'Option A' }).success).toBe(true)
  })

  test('preview stays optional in both modes', () => {
    for (const optionalDescriptions of [false, true]) {
      const schema = buildQuestionOptionSchema({
        extended: false,
        optionalDescriptions,
      })
      expect(
        schema.safeParse({
          label: 'A',
          description: 'd',
          preview: '<div>x</div>',
        }).success,
      ).toBe(true)
      expect(schema.safeParse({ label: 'A', description: 'd' }).success).toBe(
        true,
      )
    }
  })
})

describe('buildQuestionSchema — base surface', () => {
  const schema = buildQuestionSchema(BASE_FLAGS)

  test('choice questions parse (historical contract)', () => {
    expect(schema.safeParse(choiceQuestion()).success).toBe(true)
  })

  test('rejects kind — the base surface is choice-only (honest fail, not silent strip)', () => {
    const result = schema.safeParse({ ...choiceQuestion(), kind: 'text' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issues = result.error.issues.map(i => i.message)
      expect(issues.some(m => m.includes('extended-question surface'))).toBe(
        true,
      )
    }
  })

  test('rejects kind-scoped fields (min/placeholder/...)', () => {
    for (const extra of [{ min: 1 }, { placeholder: 'x' }]) {
      expect(schema.safeParse({ ...choiceQuestion(), ...extra }).success).toBe(
        false,
      )
    }
  })

  test('still requires 2-4 options', () => {
    expect(
      schema.safeParse({
        ...choiceQuestion(),
        options: [{ label: 'A', description: 'x' }],
      }).success,
    ).toBe(false)
  })
})

describe('buildQuestionSchema — extended kind face (official 0311)', () => {
  const schema = buildQuestionSchema(EXTENDED_FLAGS)

  test('choice questions parse unchanged (kind omitted)', () => {
    expect(schema.safeParse(choiceQuestion()).success).toBe(true)
  })

  test('kind text: free-text question with no options and a placeholder', () => {
    const parsed = schema.safeParse({
      question: 'What is the repo URL?',
      header: 'Repo',
      kind: 'text',
      placeholder: 'https://…',
    })
    expect(parsed.success).toBe(true)
  })

  test('kind number: min/max required with min < max', () => {
    const ok = schema.safeParse({
      question: 'How many slides?',
      header: 'Slides',
      kind: 'number',
      min: 1,
      max: 30,
      step: 1,
      defaultValue: 10,
      unit: 'slides',
    })
    expect(ok.success).toBe(true)

    const badRange = schema.safeParse({
      question: 'How many slides?',
      header: 'Slides',
      kind: 'number',
      min: 30,
      max: 1,
    })
    expect(badRange.success).toBe(false)

    const missing = schema.safeParse({
      question: 'How many slides?',
      header: 'Slides',
      kind: 'number',
      min: 1,
    })
    expect(missing.success).toBe(false)
  })

  test('number defaultValue outside min..max is rejected', () => {
    const result = schema.safeParse({
      question: 'How many slides?',
      header: 'Slides',
      kind: 'number',
      min: 1,
      max: 30,
      defaultValue: 99,
    })
    expect(result.success).toBe(false)
  })

  test('kind-scoped fields on the wrong kind are rejected', () => {
    expect(
      schema.safeParse({ ...choiceQuestion(), placeholder: 'oops' }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        question: 'open?',
        header: 'Open',
        kind: 'text',
        min: 1,
        max: 2,
      }).success,
    ).toBe(false)
  })

  test('text/number questions take no options and no multiSelect', () => {
    const withOptions = schema.safeParse({
      question: 'open?',
      header: 'Open',
      kind: 'text',
      options: [{ label: 'A' }, { label: 'B' }],
    })
    expect(withOptions.success).toBe(false)

    const withMulti = schema.safeParse({
      question: 'open?',
      header: 'Open',
      kind: 'text',
      multiSelect: true,
    })
    expect(withMulti.success).toBe(false)
  })

  test('text question without options passes (choice floor applies only to choice)', () => {
    expect(
      schema.safeParse({
        question: 'open?',
        header: 'Open',
        kind: 'text',
      }).success,
    ).toBe(true)
  })

  test('multiSelect choice keeps 2-4 option bounds', () => {
    expect(
      schema.safeParse({ ...choiceQuestion(), multiSelect: true }).success,
    ).toBe(true)
  })
})
