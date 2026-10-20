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
  QUESTION_ENTRYPOINTS,
  QUESTION_ENTRYPOINT_ENV,
  QUESTION_EXTENDED_ENV,
  QUESTION_OPTIONAL_DESCRIPTIONS_ENV,
  stripBaseQuestionFaces,
} from '../questionFlags.js'

const { zodToJsonSchema } = await import('src/utils/zodToJsonSchema.js')
const { AskUserQuestionTool } = await import('../AskUserQuestionTool.js')

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
  test('the official Pn set members are eligible (0044 module-003:1402, verbatim)', () => {
    // Every member of the official Pn set — and nothing else — is eligible.
    for (const entrypoint of QUESTION_ENTRYPOINTS) {
      expect(isQuestionEntrypointEligible(entrypoint, {})).toBe(true)
    }
    expect([...QUESTION_ENTRYPOINTS].sort()).toEqual([
      'claude-desktop',
      'claude-desktop-3p',
      'local-agent',
      'sdk-cli',
      'sdk-py',
      'sdk-ts',
    ])
  })

  test('plain cli and unknown entrypoints are not (official gate)', () => {
    expect(isQuestionEntrypointEligible('cli', {})).toBe(false)
    // Neither a bare "sdk" prefix match nor arbitrary sdk-* names are in Pn.
    expect(isQuestionEntrypointEligible('sdk', {})).toBe(false)
    expect(isQuestionEntrypointEligible('sdk-1', {})).toBe(false)
    expect(isQuestionEntrypointEligible('claude-vscode', {})).toBe(false)
    expect(isQuestionEntrypointEligible(undefined, {})).toBe(false)
    expect(isQuestionEntrypointEligible('', {})).toBe(false)
  })

  test('the remote thin-client face (s === "remote") is eligible', () => {
    // entrypoint "remote" itself…
    expect(isQuestionEntrypointEligible('remote', {})).toBe(true)
    // …and the clientType-derived remote faces (session-ingress token envs,
    // the official `P` disjunction in the clientType derivation).
    expect(
      isQuestionEntrypointEligible('cli', {
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'x',
      }),
    ).toBe(true)
    expect(
      isQuestionEntrypointEligible('cli', {
        CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR: '/dev/fd/9',
      }),
    ).toBe(true)
    expect(
      isQuestionEntrypointEligible('cli', {
        CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/tmp/tok',
      }),
    ).toBe(true)
    // Pn members stay eligible regardless of the remote envs.
    expect(
      isQuestionEntrypointEligible('sdk-ts', {
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: undefined,
      }),
    ).toBe(true)
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

  test('official raw-JS truthiness: any non-empty env string flips the switch', () => {
    // 0044 module-003:1413 `if (R && a.CLAUDE_CODE_QUESTION_EXTENDED)` — raw
    // string truthiness, so '0' / 'no' / 'false' all enable (upstream parity),
    // only unset and '' stay off.
    expect(
      getQuestionSchemaFlags({
        [QUESTION_ENTRYPOINT_ENV]: 'sdk-ts',
        [QUESTION_EXTENDED_ENV]: '0',
        [QUESTION_OPTIONAL_DESCRIPTIONS_ENV]: 'no',
      }).extended,
    ).toBe(true)
    expect(
      getQuestionSchemaFlags({
        [QUESTION_ENTRYPOINT_ENV]: 'sdk-ts',
        [QUESTION_EXTENDED_ENV]: 'false',
      }).optionalDescriptions,
    ).toBe(false)
    expect(
      getQuestionSchemaFlags({
        [QUESTION_ENTRYPOINT_ENV]: 'sdk-ts',
        [QUESTION_EXTENDED_ENV]: '',
      }).extended,
    ).toBe(false)
    // Non-members keep the switches off even when the env vars are set.
    expect(
      getQuestionSchemaFlags({
        [QUESTION_ENTRYPOINT_ENV]: 'cli',
        [QUESTION_EXTENDED_ENV]: '1',
      }).extended,
    ).toBe(false)
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

  test('accepts kind at parse time — the strip is post-parse, not in the schema', () => {
    // No schema-level .transform (it would make the schema unrepresentable in
    // JSON Schema): the base superRefine does not reject kind, the parse keeps
    // it, and {@link stripBaseQuestionFaces} drops it at the execution layer.
    const result = schema.safeParse({ ...choiceQuestion(), kind: 'text' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.kind).toBe('text')
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

describe('stripBaseQuestionFaces — post-parse base-surface strip', () => {
  test('base surface drops kind per question and clears title', () => {
    const input = {
      title: 'Before I build your deck',
      questions: [
        { ...choiceQuestion(), kind: 'text' as const },
        // Explicit undefined keeps `kind` declared on both union members so
        // the post-strip assertions can read the property on either.
        { ...choiceQuestion(), kind: undefined },
      ],
    }
    const stripped = stripBaseQuestionFaces(input, BASE_FLAGS)
    expect(stripped.title).toBeUndefined()
    expect(stripped.questions[0]!.kind).toBeUndefined()
    expect(stripped.questions[1]!.kind).toBeUndefined()
    // The rest of the question data survives the strip.
    expect(stripped.questions[0]!.question).toBe(input.questions[0]!.question)
  })

  test('extended surface passes the input through untouched', () => {
    const input = {
      title: 'Heading',
      questions: [{ ...choiceQuestion(), kind: 'text' as const }],
    }
    expect(stripBaseQuestionFaces(input, EXTENDED_FLAGS)).toBe(input)
  })

  test('tool call() re-applies the strip (execution boundary equivalence)', async () => {
    // A base-surface call with a kind face degrades to the choice picker in
    // the recorded output — the official fe=Z(C()) behavior after the
    // schema-level transform was removed.
    const result = await AskUserQuestionTool.call(
      {
        title: 'Heading',
        questions: [{ ...choiceQuestion(), kind: 'text' }],
        answers: {},
      } as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const data = (
      result as unknown as { data: { questions: { kind?: string }[] } }
    ).data
    expect(data.questions[0]!.kind).toBeUndefined()
  })
})

describe('AskUserQuestion schemas stay JSON-Schema-representable (transform ban)', () => {
  // Regression for the CRITICAL "Transforms cannot be represented in JSON
  // Schema" alert: a schema-level .transform makes toJSONSchema throw
  // (unrepresentable:'throw') and toolToAPISchema()/MCP listing call it every
  // API round-trip. The kind/title strip lives post-parse instead.
  test('input schema converts without throwing, with expected shape', () => {
    let json: Record<string, unknown>
    expect(() => {
      json = zodToJsonSchema(AskUserQuestionTool.inputSchema)
    }).not.toThrow()
    expect((json! as { type: string }).type).toBe('object')
    const properties = (json! as { properties: Record<string, unknown> })
      .properties
    expect(properties.questions).toBeDefined()
    // kind stays declared on the shared-shape schema (extended surfaces read
    // it from the schema; the base surface strips it post-parse).
    const questionItems = (
      properties.questions as { items: { properties: Record<string, unknown> } }
    ).items.properties
    expect(questionItems.kind).toBeDefined()
    expect(properties.title).toBeDefined()
  })

  test('output schema converts without throwing', () => {
    let json: Record<string, unknown>
    expect(() => {
      json = zodToJsonSchema(AskUserQuestionTool.outputSchema!)
    }).not.toThrow()
    expect((json! as { type: string }).type).toBe('object')
  })
})
