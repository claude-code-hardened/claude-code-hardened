import { FILE_EDIT_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/NotebookEditTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '@claude-code-hardened/builtin-tools/tools/WebSearchTool/prompt.js'
import { SHELL_TOOL_NAMES } from 'src/utils/shell/shellToolUtils.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

// docs: https://docs.google.com/document/d/1oCT4evvWTh3P6z-kcfNQwWTCxAhkoFndSaNS9Gm40uw/edit?tab=t.0

// Default values for context management strategies
// Match client-side microcompact token values
const DEFAULT_MAX_INPUT_TOKENS = 180_000 // Typical warning threshold
const DEFAULT_TARGET_INPUT_TOKENS = 40_000 // Keep last 40k tokens like client-side

const TOOLS_CLEARABLE_RESULTS = [
  ...SHELL_TOOL_NAMES,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
]

const TOOLS_CLEARABLE_USES = [
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]

// Context management strategy types matching API documentation
export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: {
        type: 'input_tokens'
        value: number
      }
      keep?: {
        type: 'tool_uses'
        value: number
      }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: {
        type: 'input_tokens'
        value: number
      }
    }
  | {
      type: 'clear_thinking_20251015'
      keep: 'all'
    }

// Context management configuration wrapper
export type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}

// API-based microcompact implementation that uses native context management
export function getAPIContextManagement(options?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
}): ContextManagementConfig | undefined {
  const { hasThinking = false, isRedactThinkingActive = false } = options ?? {}

  const strategies: ContextEditStrategy[] = []

  // Preserve thinking blocks in previous assistant turns. Skip when
  // redact-thinking is active — redacted blocks have no model-visible content.
  // CCH: the clearAllThinking / { type: 'thinking_turns', value: 1 } variant
  // was removed — official 2.1.284 has no such variant (grep over
  // docs/reverse-284 finds no thinking value:1 strategy), and the sole caller
  // passed `false`, making this branch dead; it regresses to keep:'all'.
  if (hasThinking && !isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: 'all',
    })
  }

  // Tool clearing: default enabled for all users (upstream gates on USER_TYPE=ant).
  // Opt out via USE_API_CLEAR_TOOL_RESULTS=0 / USE_API_CLEAR_TOOL_USES=0.
  const useClearToolResults =
    process.env.USE_API_CLEAR_TOOL_RESULTS !== undefined
      ? isEnvTruthy(process.env.USE_API_CLEAR_TOOL_RESULTS)
      : true
  const useClearToolUses = isEnvTruthy(process.env.USE_API_CLEAR_TOOL_USES)

  if (!useClearToolResults && !useClearToolUses) {
    return strategies.length > 0 ? { edits: strategies } : undefined
  }

  if (useClearToolResults) {
    const triggerThreshold = process.env.API_MAX_INPUT_TOKENS
      ? parseInt(process.env.API_MAX_INPUT_TOKENS, 10)
      : DEFAULT_MAX_INPUT_TOKENS
    const keepTarget = process.env.API_TARGET_INPUT_TOKENS
      ? parseInt(process.env.API_TARGET_INPUT_TOKENS, 10)
      : DEFAULT_TARGET_INPUT_TOKENS

    const strategy: ContextEditStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: triggerThreshold,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: triggerThreshold - keepTarget,
      },
      clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,
    }

    strategies.push(strategy)
  }

  if (useClearToolUses) {
    const triggerThreshold = process.env.API_MAX_INPUT_TOKENS
      ? parseInt(process.env.API_MAX_INPUT_TOKENS, 10)
      : DEFAULT_MAX_INPUT_TOKENS
    const keepTarget = process.env.API_TARGET_INPUT_TOKENS
      ? parseInt(process.env.API_TARGET_INPUT_TOKENS, 10)
      : DEFAULT_TARGET_INPUT_TOKENS

    const strategy: ContextEditStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: triggerThreshold,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: triggerThreshold - keepTarget,
      },
      exclude_tools: TOOLS_CLEARABLE_USES,
    }

    strategies.push(strategy)
  }

  return strategies.length > 0 ? { edits: strategies } : undefined
}
