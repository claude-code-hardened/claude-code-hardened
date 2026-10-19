import { feature } from 'bun:bundle';
import * as React from 'react';
import { getAllowedChannels, getQuestionPreviewFormat } from 'src/bootstrap/state.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { BLACK_CIRCLE } from 'src/constants/figures.js';
import { getModeColor } from 'src/utils/permissions/PermissionMode.js';
import { z } from 'zod/v4';
import { Box, Text } from '@anthropic/ink';
import type { Tool } from 'src/Tool.js';
import { buildTool, type ToolDef } from 'src/Tool.js';
import { lazySchema } from 'src/utils/lazySchema.js';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_PROMPT,
  DESCRIPTION,
  PREVIEW_FEATURE_PROMPT,
} from './prompt.js';
import { BASE_QUESTION_MAX, buildQuestionSchema, getQuestionSchemaFlags } from './questionFlags.js';

// QUESTION env extensions (CLAUDE_CODE_QUESTION_EXTENDED /
// CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS, official 0311-chunk-dyqmyxqn
// kind-form schema + 0044 chunk env gates): read once at first schema access
// so input/output schemas stay consistent.
const getQuestionFlags = () => getQuestionSchemaFlags();

const questionSchema = lazySchema(() => buildQuestionSchema(getQuestionFlags()));

const annotationsSchema = lazySchema(() => {
  const annotationSchema = z.object({
    preview: z
      .string()
      .optional()
      .describe('The preview content of the selected option, if the question used previews.'),
    notes: z.string().optional().describe('Free-text notes the user added to their selection.'),
  });

  return z
    .record(z.string(), annotationSchema)
    .optional()
    .describe(
      'Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.',
    );
});

const UNIQUENESS_REFINE = {
  check: (data: { questions: { question: string; options: { label: string }[] }[] }) => {
    const questions = data.questions.map(q => q.question);
    if (questions.length !== new Set(questions).size) {
      return false;
    }
    for (const question of data.questions) {
      const labels = question.options.map(opt => opt.label);
      if (labels.length !== new Set(labels).size) {
        return false;
      }
    }
    return true;
  },
  message: 'Question texts must be unique, option labels must be unique within each question',
} as const;

const commonFields = lazySchema(() => ({
  answers: z.record(z.string(), z.string()).optional().describe('User answers collected by the permission component'),
  annotations: annotationsSchema(),
  metadata: z
    .object({
      source: z
        .string()
        .optional()
        .describe(
          'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
        ),
    })
    .optional()
    .describe('Optional metadata for tracking and analytics purposes. Not displayed to user.'),
}));

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // Official 0311 anchor (`ye`): top-level optional single-line heading —
      // "Optional single-line heading shown above the questions, e.g. "Before
      // I build your deck".". Declared so the strictObject accepts it; the
      // base surface strips it (the official base fe=Z(C()) carries no title,
      // so the default object parse drops the unknown key).
      title: z
        .string()
        .optional()
        .describe('Optional single-line heading shown above the questions, e.g. "Before I build your deck".'),
      questions: z
        .array(questionSchema())
        .min(1)
        // QUESTION EXTENDED widens the per-question FORM (kind face) — the
        // question count cap does NOT change with the mode (R6 review: the
        // earlier 4→8 reading was a fabrication; official keeps one cap).
        .max(BASE_QUESTION_MAX)
        .describe(`Questions to ask the user (1-${BASE_QUESTION_MAX} questions)`),
      ...commonFields(),
    })
    .refine(UNIQUENESS_REFINE.check, {
      message: UNIQUENESS_REFINE.message,
    })
    .transform(data => (getQuestionFlags().extended ? data : { ...data, title: undefined })),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    questions: z.array(questionSchema()).describe('The questions that were asked'),
    answers: z
      .record(z.string(), z.string())
      .describe(
        'The answers provided by the user (question text -> answer string; multi-select answers are comma-separated)',
      ),
    annotations: annotationsSchema(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

// SDK schemas are identical to internal schemas now that `preview` and
// `annotations` are public (configurable via `toolConfig.askUserQuestion`).
export const _sdkInputSchema = inputSchema;
export const _sdkOutputSchema = outputSchema;

export type Question = z.infer<ReturnType<typeof questionSchema>>;
export type QuestionOption = Question['options'][number];
export type Output = z.infer<OutputSchema>;

function AskUserQuestionResultMessage({ answers }: { answers: Output['answers'] }): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={getModeColor('default')}>{BLACK_CIRCLE}&nbsp;</Text>
        <Text>User answered Claude&apos;s questions:</Text>
      </Box>
      <MessageResponse>
        <Box flexDirection="column">
          {Object.entries(answers).map(([questionText, answer]) => (
            <Text key={questionText} color="inactive">
              · {questionText} → {answer}
            </Text>
          ))}
        </Box>
      </MessageResponse>
    </Box>
  );
}

export const AskUserQuestionTool: Tool<InputSchema, Output> = buildTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  searchHint: 'prompt the user with a multiple-choice question',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION;
  },
  async prompt() {
    const format = getQuestionPreviewFormat();
    const flags = getQuestionFlags();
    const extensions: string[] = [];
    if (flags.extended) {
      // Official QUESTION_EXTENDED semantics (0311 anchor): widens the
      // per-question FORM with a kind face — the question count cap does not
      // move (fabricated 4→8 wording removed per R6 review).
      extensions.push(
        'Extended question form is enabled: each question may set kind — "choice" (default, options picker), "text" (free-text answer box using placeholder, no options), or "number" (value between min and max, with optional step/defaultValue/unit). Render support for text/number kinds in the terminal UI is pending (honest TODO); remote/SDK form surfaces render them fully. Until local rendering lands, prefer kind "choice" questions but keep text/number questions semantically intact — they are answered as typed text.',
      );
    }
    if (flags.optionalDescriptions) {
      extensions.push(
        'Option descriptions are optional in this session: omit the description field when the label alone is self-explanatory.',
      );
    }
    const extensionText = extensions.length > 0 ? `\n\n${extensions.join(' ')}` : '';
    if (format === undefined) {
      // SDK consumer that hasn't opted into a preview format — omit preview
      // guidance (they may not render the field at all).
      return ASK_USER_QUESTION_TOOL_PROMPT + extensionText;
    }
    return ASK_USER_QUESTION_TOOL_PROMPT + PREVIEW_FEATURE_PROMPT[format] + extensionText;
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return '';
  },
  isEnabled() {
    // When --channels is active the user is likely on Telegram/Discord, not
    // watching the TUI. The multiple-choice dialog would hang with nobody at
    // the keyboard. Channel permission relay already skips
    // requiresUserInteraction() tools (interactiveHandler.ts) so there's
    // no alternate approval path.
    if ((feature('KAIROS') || feature('KAIROS_CHANNELS')) && getAllowedChannels().length > 0) {
      return false;
    }
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  isReadOnly() {
    return true;
  },
  toAutoClassifierInput(input) {
    // Official parity (0311 anchor): kind facets are only exposed to the
    // classifier when the extended surface is active.
    const flags = getQuestionFlags();
    return input.questions
      .map(q => {
        let facets = '';
        if (flags.extended) {
          const kindFacets: [string, unknown][] = [
            ['kind', q.kind],
            ['description', q.description],
            ['placeholder', q.placeholder],
            ['min', q.min],
            ['max', q.max],
            ['step', q.step],
            ['default', q.defaultValue],
            ['unit', q.unit],
          ];
          for (const [name, value] of kindFacets) {
            if (value !== undefined && value !== '') facets += ` [${name}: ${String(value)}]`;
          }
        }
        return `"${q.question}"${facets} options: ${q.options.map(o => o.label).join(', ')}`;
      })
      .join(' | ');
  },
  requiresUserInteraction() {
    return true;
  },
  async validateInput({ questions }) {
    if (getQuestionPreviewFormat() !== 'html') {
      return { result: true };
    }
    for (const q of questions) {
      for (const opt of q.options) {
        const err = validateHtmlPreview(opt.preview);
        if (err) {
          return {
            result: false,
            message: `Option "${opt.label}" in question "${q.question}": ${err}`,
            errorCode: 1,
          };
        }
      }
    }
    return { result: true };
  },
  async checkPermissions(input) {
    return {
      behavior: 'ask' as const,
      message: 'Answer questions?',
      updatedInput: input,
    };
  },
  renderToolUseMessage() {
    return null;
  },
  renderToolUseProgressMessage() {
    return null;
  },
  renderToolResultMessage({ answers }, _toolUseID) {
    return <AskUserQuestionResultMessage answers={answers} />;
  },
  renderToolUseRejectedMessage() {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={getModeColor('default')}>{BLACK_CIRCLE}&nbsp;</Text>
        <Text>User declined to answer questions</Text>
      </Box>
    );
  },
  renderToolUseErrorMessage() {
    return null;
  },
  async call({ questions, answers = {}, annotations }, _context) {
    return {
      data: { questions, answers, ...(annotations && { annotations }) },
    };
  },
  mapToolResultToToolResultBlockParam({ answers, annotations }, toolUseID) {
    const answersText = Object.entries(answers)
      .map(([questionText, answer]) => {
        const annotation = annotations?.[questionText];
        const parts = [`"${questionText}"="${answer}"`];
        if (annotation?.preview) {
          parts.push(`selected preview:\n${annotation.preview}`);
        }
        if (annotation?.notes) {
          parts.push(`user notes: ${annotation.notes}`);
        }
        return parts.join(' ');
      })
      .join(', ');

    return {
      type: 'tool_result',
      content: `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`,
      tool_use_id: toolUseID,
    };
  },
} satisfies ToolDef<InputSchema, Output>);

// Lightweight HTML fragment check. Not a parser — HTML5 parsers are
// error-recovering by spec and accept anything. We're checking model intent
// (did it emit HTML?) and catching the specific things we told it not to do.
function validateHtmlPreview(preview: string | undefined): string | null {
  if (preview === undefined) return null;
  if (/<\s*(html|body|!doctype)\b/i.test(preview)) {
    return 'preview must be an HTML fragment, not a full document (no <html>, <body>, or <!DOCTYPE>)';
  }
  // SDK consumers typically set this via innerHTML — disallow executable/style
  // tags so a preview can't run code or restyle the host page. Inline event
  // handlers (onclick etc.) are still possible; consumers should sanitize.
  if (/<\s*(script|style)\b/i.test(preview)) {
    return 'preview must not contain <script> or <style> tags. Use inline styles via the style attribute if needed.';
  }
  if (!/<[a-z][^>]*>/i.test(preview)) {
    return 'preview must contain HTML (previewFormat is set to "html"). Wrap content in a tag like <div> or <pre>.';
  }
  return null;
}
