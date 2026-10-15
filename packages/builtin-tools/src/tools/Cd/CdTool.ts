import { realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import { z } from 'zod/v4'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { isENOENT } from 'src/utils/errors.js'
import { onCwdChangedForHooks } from 'src/utils/hooks/fileChangedWatcher.js'
import { invalidateSessionEnvCache } from 'src/utils/sessionEnvironment.js'
import { setCwd } from 'src/utils/Shell.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { getRuleByContentsForToolName } from 'src/utils/permissions/permissions.js'
import type { PermissionRule } from 'src/types/permissions.js'
import { CD_TOOL_NAME } from './constants.js'
import { expandTilde, pathMatchesRule } from './matchers.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

/**
 * CdTool — restore of the official 2.1.284 `Cd` tool
 * (docs/reverse-284/full-source/_ALL.js:42543, `var D="Cd"`).
 *
 * Semantics ported from the official `ICn` check function:
 *   stat      → `not_found` / `not_a_directory` (with parent dir reported)
 *   realpath  → canonical target; symlinked paths resolve to their physical
 *               directory before any rule evaluation
 *   same      → target equals the session cwd AND the original cwd → no-op
 *   rules     → official `x()`: `Cd` deny rules (bare rules block everything)
 *               refuse with `blocked_by_rule`; when `Cd` allow rules exist the
 *               canonical realpath must match one of them, otherwise
 *               `outside_allowed_patterns` is refused (official `B()` refuses
 *               realpath escapes `..` / `../..` outside the rule root).
 *   apply     → setCwd + session-env cache invalidation + CwdChanged hook
 *               dispatch (mirrors the post-command sync in Shell.ts).
 */

const inputSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .describe(
        'The directory to change into. Absolute path, path relative to the current working directory, or `~`-prefixed path (expanded to the home directory). Must exist and be a directory.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type CdInput = z.infer<InputSchema>

export type CdOutput = {
  /** Path exactly as requested by the model. */
  requested: string
  /** Canonical (realpath'd) working directory after the change. */
  directory: string
  message: string
  /** Set when the change was refused — becomes `is_error` in the tool result. */
  error?: string
}

type CdPermissionContext = Parameters<typeof getRuleByContentsForToolName>[0]

type CdTargetResolution = {
  currentDir: string
  requested: string
  canonical: string
}

type CdEvaluation =
  | { result: 'allowed' }
  | { result: 'blockedByRule'; rule: PermissionRule }
  | {
      result: 'outsideAllowedPatterns'
      allowedPatterns: string[]
    }

type CdTargetCheck =
  | { result: 'ok'; canonical: string }
  | { result: 'same'; canonical: string }
  | { result: 'not_found'; path: string }
  | { result: 'not_a_directory'; path: string; parent: string }

async function resolveCdTarget(input: string): Promise<CdTargetResolution> {
  // Respect per-agent cwd overrides (AsyncLocalStorage) so a subagent's
  // relative paths resolve against its own directory, not the global one.
  const currentDir = getCwd()
  const expanded = expandTilde(input)
  const requested = isAbsolute(expanded)
    ? expanded
    : resolve(currentDir, expanded)
  // Official: realpath falls back to the requested path when it fails; the
  // subsequent stat decides between not_found / ok.
  let canonical = requested
  try {
    canonical = await realpath(requested)
  } catch {
    canonical = requested
  }
  return { currentDir, requested, canonical }
}

async function checkCdTarget({
  canonical,
}: Pick<CdTargetResolution, 'canonical'>): Promise<CdTargetCheck> {
  try {
    const st = await stat(canonical)
    if (!st.isDirectory()) {
      return {
        result: 'not_a_directory',
        path: canonical,
        parent: dirname(canonical),
      }
    }
  } catch (e) {
    if (isENOENT(e)) {
      return { result: 'not_found', path: canonical }
    }
    return { result: 'not_found', path: canonical }
  }
  // Re-resolve after the existence check so the canonical path reflects the
  // physical directory (realpath may succeed once the target exists).
  let finalCanonical = canonical
  try {
    finalCanonical = await realpath(canonical)
  } catch {
    finalCanonical = canonical
  }
  return { result: 'ok', canonical: finalCanonical }
}

function getPermissionContext(context: {
  getAppState?: () => { toolPermissionContext?: CdPermissionContext }
}): CdPermissionContext | undefined {
  try {
    return context.getAppState?.().toolPermissionContext
  } catch {
    // Headless/minimal contexts may not carry app state — the tool-level
    // rule gate is best effort; the general permission system still runs.
    return undefined
  }
}

/**
 * Port of the official `x()` permission evaluation for `Cd`:
 * - deny rules: bare rule (ruleContent undefined) blocks any target;
 *   patterned rules block when the requested or canonical realpath matches.
 * - allow rules: none present → everything allowed; present → the canonical
 *   realpath must match at least one (bare allow rules match everything).
 *   Non-matches yield `outsideAllowedPatterns`, whose refusal message lists
 *   the configured patterns (see checkPermissions messages).
 */
function evaluateCdRules(
  permissionContext: CdPermissionContext,
  targets: string[],
  canonical: string,
  currentDir: string,
): CdEvaluation {
  for (const rule of getRuleByContentsForToolName(
    permissionContext,
    CD_TOOL_NAME,
    'deny',
  ).values()) {
    const content = rule.ruleValue.ruleContent
    if (content === undefined) {
      return { result: 'blockedByRule', rule }
    }
    const pattern: string = content
    if (targets.some(t => pathMatchesRule(pattern, t, currentDir))) {
      return { result: 'blockedByRule', rule }
    }
  }
  const allowRules = getRuleByContentsForToolName(
    permissionContext,
    CD_TOOL_NAME,
    'allow',
  )
  if (allowRules.size === 0) return { result: 'allowed' }
  for (const rule of allowRules.values()) {
    const content = rule.ruleValue.ruleContent
    if (
      content === undefined ||
      pathMatchesRule(content, canonical, currentDir)
    ) {
      return { result: 'allowed' }
    }
  }
  return {
    result: 'outsideAllowedPatterns',
    allowedPatterns: [...allowRules.values()]
      .map(r => r.ruleValue.ruleContent)
      .filter((c): c is string => c !== undefined),
  }
}

function describeBlocked(evaluation: CdEvaluation, canonical: string): string {
  if (evaluation.result === 'blockedByRule') {
    const source = evaluation.rule.source
    if (evaluation.rule.ruleValue.ruleContent === undefined) {
      return `cd: blocked_by_rule — Can't move to ${canonical} — directory changes are turned off by the ${source} rule. Update the rule in /permissions to move between directories again.`
    }
    return `cd: blocked_by_rule — Can't move to ${canonical} — it's excluded by the ${source} rule. Pick a directory outside that rule, or update it in /permissions.`
  }
  if (evaluation.result === 'outsideAllowedPatterns') {
    return `cd: outside_allowed_patterns — Can't move to ${canonical} — directory changes are limited to ${evaluation.allowedPatterns.join(', ')}. Pick a matching directory, or add a Cd rule in /permissions.`
  }
  return `cd: blocked_by_rule — Can't move to ${canonical}.`
}

export const CdTool = buildTool({
  name: CD_TOOL_NAME,
  searchHint: 'cd chdir change directory cwd move working directory',
  maxResultSizeChars: 2_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  interruptBehavior() {
    return 'cancel'
  },

  userFacingName() {
    return CD_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<CdInput>) {
    return `Cd: ${input.path ?? '?'}`
  },

  getToolUseSummary(input: Partial<CdInput> | undefined) {
    return input?.path ?? null
  },

  getActivityDescription(input: CdInput) {
    return `Moving to ${input.path}`
  },

  toAutoClassifierInput(input: CdInput) {
    return input.path
  },

  async validateInput(
    input: CdInput,
  ): Promise<
    { result: true } | { result: false; message: string; errorCode: number }
  > {
    const target = await resolveCdTarget(input.path)
    const check = await checkCdTarget(target)
    if (check.result === 'not_found') {
      return {
        result: false,
        message: `cd: not_found — Path "${check.path}" does not exist`,
        errorCode: 2,
      }
    }
    if (check.result === 'not_a_directory') {
      return {
        result: false,
        message: `cd: not_a_directory — "${check.path}" is not a directory (parent: ${check.parent})`,
        errorCode: 3,
      }
    }
    return { result: true }
  },

  async checkPermissions(input: CdInput, context) {
    const { currentDir, requested, canonical } = await resolveCdTarget(
      input.path,
    )
    const targetCheck = await checkCdTarget({ canonical })
    if (targetCheck.result !== 'ok' && targetCheck.result !== 'same') {
      // Existence/directory problems surface in validateInput; keep the
      // permission layer permissive for them so error wording stays central.
      return { behavior: 'allow', updatedInput: input }
    }
    const finalCanonical = targetCheck.canonical
    if (finalCanonical === currentDir && finalCanonical === getOriginalCwd()) {
      // No-op move — nothing to gate.
      return { behavior: 'allow', updatedInput: input }
    }
    const permissionContext = getPermissionContext(context)
    if (!permissionContext) {
      return { behavior: 'allow', updatedInput: input }
    }
    const evaluation = evaluateCdRules(
      permissionContext,
      [requested, finalCanonical],
      finalCanonical,
      currentDir,
    )
    if (evaluation.result === 'allowed') {
      return { behavior: 'allow', updatedInput: input }
    }
    if (evaluation.result === 'blockedByRule') {
      return {
        behavior: 'deny',
        message: describeBlocked(evaluation, finalCanonical),
        decisionReason: { type: 'rule', rule: evaluation.rule },
      }
    }
    return {
      behavior: 'deny',
      message: describeBlocked(evaluation, finalCanonical),
      decisionReason: { type: 'other', reason: 'outside_allowed_patterns' },
    }
  },

  async call(input: CdInput, context): Promise<{ data: CdOutput }> {
    const { currentDir, requested, canonical } = await resolveCdTarget(
      input.path,
    )
    // Defense in depth: re-run the official ICn checks — validateInput and
    // checkPermissions may be bypassed by non-standard pipelines.
    const targetCheck = await checkCdTarget({ canonical })
    if (targetCheck.result === 'not_found') {
      return {
        data: {
          requested,
          directory: currentDir,
          message: '',
          error: `cd: not_found — Path "${targetCheck.path}" does not exist`,
        },
      }
    }
    if (targetCheck.result === 'not_a_directory') {
      return {
        data: {
          requested,
          directory: currentDir,
          message: '',
          error: `cd: not_a_directory — "${targetCheck.path}" is not a directory (parent: ${targetCheck.parent})`,
        },
      }
    }

    const finalCanonical = targetCheck.canonical

    // Official `same` no-op: target equals the session cwd AND the original cwd.
    if (finalCanonical === currentDir && finalCanonical === getOriginalCwd()) {
      return {
        data: {
          requested,
          directory: finalCanonical,
          message: `Already in ${finalCanonical}.`,
        },
      }
    }

    const permissionContext = getPermissionContext(context)
    if (permissionContext) {
      const evaluation = evaluateCdRules(
        permissionContext,
        [requested, finalCanonical],
        finalCanonical,
        currentDir,
      )
      if (evaluation.result !== 'allowed') {
        return {
          data: {
            requested,
            directory: currentDir,
            message: '',
            error: describeBlocked(evaluation, finalCanonical),
          },
        }
      }
    }

    // Apply — same trio the post-command sync uses in Shell.ts:
    // setCwd (realpath + setCwdState) → invalidate session env cache →
    // CwdChanged hook dispatch (CCH's CwdChanged-equivalent sync point).
    setCwd(finalCanonical)
    invalidateSessionEnvCache()
    void onCwdChangedForHooks(currentDir, finalCanonical)

    return {
      data: {
        requested,
        directory: finalCanonical,
        message: `Working directory changed to ${finalCanonical} (was ${currentDir}). All tool calls and relative paths now resolve from ${finalCanonical}.`,
      },
    }
  },

  mapToolResultToToolResultBlockParam(
    output: CdOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    const text = output.error ?? output.message
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: text,
      is_error: output.error !== undefined,
    }
  },
})
