// QUESTION env extensions — official anchor docs/reverse-284/decompiled
// 0311-chunk-dyqmyxqn/module-002-uncategorized.js (schema `Y`/`pe`) +
// 0044-chunk-zrkp23rq/module-002-env-vars.js:38-39 (+ usage in module-003):
//   if (entrypointEligible && CLAUDE_CODE_QUESTION_EXTENDED) O6r(true)
//     → extended question FORM: each question gains a `kind` face
//       ("choice" default / "text" free-text / "number" min..max control)
//       with kind-scoped fields (description/placeholder/min/max/step/
//       defaultValue/unit). The question COUNT cap does NOT change with the
//       mode (R6 review: the earlier 4→8 readings was a fabrication — the
//       cap stays 4 in both modes).
//   if (entrypointEligible && CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS)
//     M6r(true) → option descriptions become optional (wording per official W).
// Official gating: only honored for remote/SDK surfaces —
// `R = Pn.has(CLAUDE_CODE_ENTRYPOINT) || clientType === 'remote'` — the plain
// `cli` entrypoint keeps the base schema.
// Pure module (zod only) so the schema and its tests stay free of the ink
// dependency chain.

import { z } from 'zod/v4'

export const QUESTION_EXTENDED_ENV = 'CLAUDE_CODE_QUESTION_EXTENDED'
export const QUESTION_OPTIONAL_DESCRIPTIONS_ENV =
  'CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS'
export const QUESTION_ENTRYPOINT_ENV = 'CLAUDE_CODE_ENTRYPOINT'

/**
 * Question count cap — identical in both modes (official: QUESTION_EXTENDED
 * widens the per-question FORM, not the per-call question count).
 */
export const BASE_QUESTION_MAX = 4

export interface QuestionSchemaFlags {
  extended: boolean
  optionalDescriptions: boolean
}

/** Entrypoints that honor the QUESTION_* extensions, per the official gate
 * (remote thin client + SDK entrypoints; plain `cli` excluded). */
export function isQuestionEntrypointEligible(
  entrypoint: string | undefined,
): boolean {
  if (!entrypoint) return false
  return entrypoint === 'remote' || entrypoint.startsWith('sdk')
}

function envTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

/** Read the QUESTION_* env switches. `env` defaults to process.env; pass a
 * literal for deterministic tests. */
export function getQuestionSchemaFlags(
  env: Record<string, string | undefined> = process.env,
): QuestionSchemaFlags {
  const eligible = isQuestionEntrypointEligible(env[QUESTION_ENTRYPOINT_ENV])
  return {
    extended: eligible && envTruthy(env[QUESTION_EXTENDED_ENV]),
    optionalDescriptions:
      eligible && envTruthy(env[QUESTION_OPTIONAL_DESCRIPTIONS_ENV]),
  }
}

/** Option schema factory. Non-extended + optionalDescriptions=false keeps
 * `description` required — byte-identical to the historical schema. Extended
 * mode always allows omitting the description, with the official wording
 * (0311 anchor option schema `W`). */
export function buildQuestionOptionSchema(flags: QuestionSchemaFlags) {
  const shortHandOptional = flags.extended || flags.optionalDescriptions
  return z.object({
    label: z
      .string()
      .describe(
        'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
      ),
    description: (shortHandOptional
      ? z.string().optional()
      : z.string()
    ).describe(
      flags.extended
        ? 'Optional: add only when the label alone would be ambiguous. One short line on what choosing it leads to.'
        : 'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.' +
            (flags.optionalDescriptions
              ? ' Optional: omit when the label alone is self-explanatory.'
              : ''),
    ),
    preview: z
      .string()
      .optional()
      .describe(
        'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
      ),
  })
}

const QUESTION_KINDS = ['choice', 'text', 'number'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

/**
 * Builds the per-question schema for the given flag state.
 *
 * Base (extended=false): the historical choice-only question. A `kind` field
 * is SILENTLY STRIPPED at parse time — official fe=Z(C()) semantics (0311
 * anchor: the base input schema `fe` wraps the base question shape `C()`,
 * which does not declare `kind`, so the default zod object parse drops the
 * unknown key without an error). The kind-scoped form fields
 * (placeholder/min/max/step/defaultValue/unit) stay hard rejections on the
 * base surface: stripping those would silently downgrade typed values.
 *
 * Extended (extended=true): the official 0311 `ye` schema — `kind` switches
 * the answer form; `options` becomes omittable (choice-only, default []); the
 * kind-scoped fields (description/placeholder/min/max/step/defaultValue/unit)
 * validate per the official `pe` superRefine.
 */
export function buildQuestionSchema(flags: QuestionSchemaFlags) {
  const optionSchema = buildQuestionOptionSchema(flags)

  // Note: "max 12 chars" in the header description mirrors prompt.ts
  // ASK_USER_QUESTION_TOOL_CHIP_WIDTH; this module stays pure (zod only), so
  // it does not import that constant — keep the two in sync.

  // Single object shape in both modes (union-free schema keeps `Question`
  // inference and downstream consumers stable); the refinement decides which
  // fields the active surface accepts.
  return (
    z
      .object({
        question: z
          .string()
          .describe(
            'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
          ),
        header: z
          .string()
          .describe(
            'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
          ),
        kind: z
          .enum(QUESTION_KINDS)
          .optional()
          .describe(
            'How the user answers. "choice" (the default when omitted): picks from options. "text": a free-text box, no options — for open-ended input. "number": a slider/stepper between min and max — for quantities. (Extended-question surface only.)',
          ),
        description: z
          .string()
          .optional()
          .describe('Optional single helper line shown under the question.'),
        options: optionSchema
          .array()
          .max(4)
          .default(() => [])
          .describe(
            'Choices for a "choice" question: 2-4 distinct options; with multiSelect false they must be mutually exclusive. Omit for "text" and "number" questions (extended surface). There should be no \'Other\' or \'Skip\' option; the form lets the user type their own answer or leave a question unanswered.',
          ),
        multiSelect: z
          .boolean()
          .default(false)
          .describe(
            'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive. Choice questions only.',
          ),
        placeholder: z
          .string()
          .optional()
          .describe(
            '"text" questions only: placeholder for the empty text box.',
          ),
        min: z
          .number()
          .optional()
          .describe('"number" questions only (required there): lowest value.'),
        max: z
          .number()
          .optional()
          .describe('"number" questions only (required there): highest value.'),
        step: z
          .number()
          .positive()
          .optional()
          .describe('"number" questions only: increment between values.'),
        defaultValue: z
          .number()
          .optional()
          .describe(
            '"number" questions only: the value the control starts at (within min..max).',
          ),
        unit: z
          .string()
          .optional()
          .describe(
            '"number" questions only: short unit shown next to the value, e.g. "px", "slides", "%".',
          ),
      })
      .superRefine((q, ctx) => {
        // ── Base surface (extended=false): choice-only, historical contract ──
        // `kind` itself is NOT rejected here — the official base schema
        // fe=Z(C()) (0311 anchor) strips the undeclared key at parse time; the
        // transform below mirrors that strip. Kind-scoped form fields stay
        // rejected: stripping those would silently downgrade typed values into
        // an empty choice UI.
        if (!flags.extended) {
          for (const field of [
            'description',
            'placeholder',
            'min',
            'max',
            'step',
            'defaultValue',
            'unit',
          ] as const) {
            if (q[field] !== undefined) {
              ctx.addIssue({
                code: 'custom',
                path: [field],
                message: `${field} applies only to the extended-question surface (CLAUDE_CODE_QUESTION_EXTENDED with a remote/SDK entrypoint).`,
              })
            }
          }
          if (q.options.length < 2) {
            ctx.addIssue({
              code: 'custom',
              path: ['options'],
              message: 'A choice question needs 2-4 options.',
            })
          }
          return
        }

        // ── Extended surface: official 0311 `pe` superRefine ──
        const kind: QuestionKind = q.kind ?? 'choice'
        for (const [field, fieldKind] of [
          ['placeholder', 'text'],
          ['min', 'number'],
          ['max', 'number'],
          ['step', 'number'],
          ['defaultValue', 'number'],
          ['unit', 'number'],
        ] as const) {
          if (kind !== fieldKind && q[field] !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [field],
              message: `${field} applies only to "${fieldKind}" questions.`,
            })
          }
        }

        if (kind === 'choice') {
          if (q.options.length < 2) {
            ctx.addIssue({
              code: 'custom',
              path: ['options'],
              message:
                'A choice question needs 2-4 options; use kind "text" for an open-ended question.',
            })
          }
          return
        }

        if (q.options.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['options'],
            message: `A "${kind}" question takes no options; remove them or omit kind to ask a choice question.`,
          })
        }
        if (q.multiSelect) {
          ctx.addIssue({
            code: 'custom',
            path: ['multiSelect'],
            message: `multiSelect applies only to choice questions, not "${kind}".`,
          })
        }
        if (kind !== 'number') return
        const { min, max, defaultValue } = q
        if (min === undefined || max === undefined || !(min < max)) {
          ctx.addIssue({
            code: 'custom',
            path: ['min'],
            message:
              'A number question needs numeric min and max with min < max.',
          })
          return
        }
        if (
          defaultValue !== undefined &&
          (defaultValue < min || defaultValue > max)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['defaultValue'],
            message: 'defaultValue must lie within min..max.',
          })
        }
      })
      // Official fe=Z(C()) semantics (0311 anchor): the base question shape does
      // not declare `kind`, so the base parse silently drops it instead of
      // erroring — a base surface call with kind:"text" degrades to the choice
      // picker, exactly as upstream. Shared object shape keeps the Question
      // inference intact, so the strip is an explicit base-mode transform.
      .transform(q =>
        flags.extended ? q : ({ ...q, kind: undefined } as typeof q),
      )
  )
}
