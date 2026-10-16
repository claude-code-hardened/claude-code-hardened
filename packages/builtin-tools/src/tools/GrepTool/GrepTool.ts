import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { isENOENT } from 'src/utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE, suggestPathUnderCwd } from 'src/utils/file.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { expandPath, toRelativePath } from 'src/utils/path.js'
import {
  checkReadPermissionForTool,
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from 'src/utils/permissions/filesystem.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/utils/permissions/shellRuleMatching.js'
import { getGlobExclusionsForPluginCache } from 'src/utils/plugins/orphanedPluginFilter.js'
import { ripGrep } from 'src/utils/ripgrep.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'
import { semanticNumber } from 'src/utils/semanticNumber.js'
import { plural } from 'src/utils/stringUtils.js'
import {
  attachSearchCancel,
  type GrepOptionsLike,
  type GrepResultLike,
  loadSearchNative,
  renderGrepMatches,
} from '../../../../search-napi/src/index'
import { GREP_TOOL_NAME, getDescription } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z
      .string()
      .describe(
        'The regular expression pattern to search for in file contents',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'File or directory to search in (rg PATH). Defaults to current working directory.',
      ),
    glob: z
      .string()
      .optional()
      .describe(
        'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
      ),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe(
        'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
      ),
    '-B': semanticNumber(z.number().optional()).describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
    '-A': semanticNumber(z.number().optional()).describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
    '-C': semanticNumber(z.number().optional()).describe('Alias for context.'),
    context: semanticNumber(z.number().optional()).describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
    '-n': semanticBoolean(z.boolean().optional()).describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
    '-i': semanticBoolean(z.boolean().optional()).describe(
      'Case insensitive search (rg -i)',
    ),
    type: z
      .string()
      .optional()
      .describe(
        'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
      ),
    head_limit: semanticNumber(z.number().optional()).describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
    ),
    offset: semanticNumber(z.number().optional()).describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
    multiline: semanticBoolean(z.boolean().optional()).describe(
      'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Version control system directories to exclude from searches
// These are excluded automatically because they create noise in search results
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
] as const

// Default cap on grep results when head_limit is unspecified. Unbounded content-mode
// greps can fill up to the 20KB persist threshold (~6-24K tokens/grep-heavy session).
// 250 is generous enough for exploratory searches while preventing context bloat.
// Pass head_limit=0 explicitly for unlimited.
const DEFAULT_HEAD_LIMIT = 250

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  // Explicit 0 = unlimited escape hatch
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  // Only report appliedLimit when truncation actually occurred, so the model
  // knows there may be more results and can paginate with offset.
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

// Format limit/offset information for display in tool results.
// appliedLimit is only set when truncation actually occurred (see applyHeadLimit),
// so it may be undefined even when appliedOffset is set — build parts conditionally
// to avoid "limit: undefined" appearing in user-visible output.
function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

// Splits a ripgrep content-mode line into [file path, rest], where rest keeps
// the separator colon and whatever follows (line number + content). Splitting
// on the plain first colon breaks real-world paths:
//   - Windows drive letters: `C:\a.ts:12:x` must split at ':12', not after 'C'
//   - backslash-escaped colons: `a\:b.ts:12:x` must skip the `\:`
// Primary rule per upstream format: the -n line-number separator is the first
// colon immediately followed by a digit (escaped colons are skipped). Fall
// back to the first unescaped, non-drive colon for line-number-less output
// (`rg` without -n: `path:content`). Returns null when nothing plausible
// matches, so callers pass the line through untouched. Exported for tests.
export function splitContentLine(line: string): [string, string] | null {
  // Zero-width lookarounds: skip colons escaped as `\:`; the match consumes
  // only the colon itself, so index math stays trivial.
  const lineNumColon = line.search(/(?<!\\):(?=\d)/)
  if (lineNumColon > 0) {
    return [line.substring(0, lineNumColon), line.substring(lineNumColon)]
  }
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ':') {
      continue
    }
    if (i > 0 && line[i - 1] === '\\') {
      continue
    }
    if (i === 1) {
      break // drive-letter colon (`C:\...`) — no safe split point
    }
    return [line.substring(0, i), line.substring(i)]
  }
  return null
}

/** Exported for unit tests (lineParsing.test.ts) — pure path-normalization. */
export function relativeContentLine(line: string): string {
  const split = splitContentLine(line)
  if (split) {
    const [filePath, rest] = split
    return toRelativePath(filePath) + rest
  }
  return line
}

const outputSchema = lazySchema(() =>
  z.object({
    mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    numFiles: z.number(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().optional(), // For content mode
    numMatches: z.number().optional(), // For count mode
    appliedLimit: z.number().optional(), // The limit that was applied (if any)
    appliedOffset: z.number().optional(), // The offset that was applied
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

// SEARCH_NAPI native-first branch (flag-gated — zero impact while off).
// Loads the in-process Rust search engine (packages/search-napi), renders its
// matches into byte-identical rg subprocess output (see renderGrepMatches in
// packages/search-napi/src/index.ts for the format anchors), then reuses
// applyHeadLimit + relativeContentLine + the exact Output assembly of the rg
// branch below. head_limit/offset stay post-hoc on rendered lines, like the
// rg path which never passes them to the rg process. Any native absence or
// failure returns null so the untouched rg path runs — the renderer contract
// is that splitContentLine/relativeContentLine/count parsing round-trip every
// emitted line.
type NativeCallContext = {
  abortController: AbortController
  getAppState: () => {
    toolPermissionContext: Parameters<typeof getFileReadIgnorePatterns>[0]
  }
}

type NativeGrepArgs = {
  pattern: string
  path?: string | undefined
  glob?: string | undefined
  type?: string | undefined
  output_mode?: string | undefined
  context_before?: number | undefined
  context_after?: number | undefined
  context_c?: number | undefined
  context?: number | undefined
  showLineNumbers?: boolean | undefined
  case_insensitive?: boolean | undefined
  multiline?: boolean | undefined
  head_limit?: number | undefined
  offset?: number | undefined
}

async function nativeGrepOutput(
  args: NativeGrepArgs,
  { abortController, getAppState }: NativeCallContext,
): Promise<Output | null> {
  const mod = loadSearchNative()
  if (mod === null || abortController.signal.aborted) {
    return null
  }

  const {
    pattern,
    path,
    glob,
    type,
    output_mode = 'files_with_matches',
    context_before,
    context_after,
    context_c,
    context,
    showLineNumbers = true,
    case_insensitive = false,
    multiline = false,
    head_limit,
    offset = 0,
  } = args

  const absolutePath = path ? expandPath(path) : getCwd()

  // Compose the single glob expression the native pipeline accepts
  // (comma/space separated, `!`-negated). The user glob is split exactly like
  // the rg branch; pieces are space-joined so comma-bearing brace patterns
  // keep their commas — but a piece that itself contains a comma or any
  // whitespace cannot round-trip the native comma/space split (e.g.
  // "*.{ts,tsx}" or an ignore rule with spaces) → bail out to rg, which
  // passes those as separate --glob args with byte-perfect semantics.
  const globParts: string[] = []
  if (glob) {
    const rawPatterns = glob.split(/\s+/)
    for (const rawPattern of rawPatterns) {
      if (rawPattern.includes('{') && rawPattern.includes('}')) {
        globParts.push(rawPattern)
      } else {
        globParts.push(...rawPattern.split(',').filter(Boolean))
      }
    }
  }
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    globParts.push(`!${dir}`)
  }
  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(getAppState().toolPermissionContext),
    getCwd(),
  )
  for (const ignorePattern of ignorePatterns) {
    // Same positive→negative rewrite as the rg branch below (ripgrep applies
    // gitignore-style globs relative to the search root).
    globParts.push(
      ignorePattern.startsWith('/')
        ? `!${ignorePattern}`
        : `!**/${ignorePattern}`,
    )
  }
  for (const exclusion of await getGlobExclusionsForPluginCache(absolutePath)) {
    globParts.push(exclusion)
  }
  const nativeUnsafeGlob = globParts.some(
    part => part.includes(',') || /\s/.test(part),
  )
  if (nativeUnsafeGlob) {
    return null
  }
  const globExpr = globParts.length > 0 ? globParts.join(' ') : undefined

  // -C/context takes precedence over -B/-A (same as the rg branch).
  const sharedContext = context ?? context_c
  const cancelKey = randomUUID()
  const options: GrepOptionsLike = {
    pattern,
    path: absolutePath,
    glob: globExpr,
    type,
    ignoreCase: case_insensitive,
    multiline,
    hidden: true, // rg branch: --hidden
    gitignore: true, // rg path never passes --no-ignore → respect gitignore
    maxColumns: 500, // rg branch: --max-columns 500
    mode:
      output_mode === 'files_with_matches'
        ? 'FilesWithMatches'
        : output_mode === 'count'
          ? 'Count'
          : 'Content',
    timeoutMs: 20_000, // rg default timeout; native heart token double-insures
    // Per-call cancel key: abortSignal → searchCancel(key) kills ONLY this
    // session (heart.rs CancelRegistry) — concurrent native searches and the
    // probe's legacy global-cancel surface never cross-cancel.
    cancelKey,
  }
  // Content mode: let the native pipeline stop reading at the pagination
  // budget (rg -mN semantics; max_count counts match lines). head_limit=0 is
  // the explicit unlimited escape hatch handled in applyHeadLimit.
  if (output_mode === 'content') {
    const effectiveHeadLimit =
      head_limit === 0 ? undefined : (head_limit ?? DEFAULT_HEAD_LIMIT)
    if (effectiveHeadLimit !== undefined) {
      options.maxCount = effectiveHeadLimit + offset
    }
  }
  if (sharedContext !== undefined) {
    options.contextBefore = sharedContext
    options.contextAfter = sharedContext
  } else {
    if (context_before !== undefined) {
      options.contextBefore = context_before
    }
    if (context_after !== undefined) {
      options.contextAfter = context_after
    }
  }
  // rg only emits `--` group separators when context lines are involved at
  // all (zero-width context behaves like no context).
  const hadContext =
    (options.contextBefore ?? 0) > 0 || (options.contextAfter ?? 0) > 0

  const cancel = attachSearchCancel(mod, abortController.signal, cancelKey)
  let result: GrepResultLike
  try {
    result = await mod.grepSearch(options)
  } catch {
    // Native engine failure (bad regex, aborted session, …) → rg path below.
    return null
  } finally {
    cancel()
  }
  // Structural shape probe (validate-probe defense in depth): a payload that
  // doesn't look like GrepResult bails to the rg path instead of rendering
  // garbage. (med: Array.isArray defenses.)
  if (
    result === null ||
    typeof result !== 'object' ||
    !Array.isArray(result.matches)
  ) {
    return null
  }
  // Cancelled pipeline (searchCancel / native timeout) → hand the call to the
  // rg branch, whose own timeout/abort surfaces the exact same error class
  // users see from the subprocess path today — never a silently truncated
  // residual table.
  if (result.cancelled === true) {
    return null
  }

  if (output_mode === 'content') {
    const rendered = renderGrepMatches(result.matches, {
      mode: 'Content',
      context: hadContext,
      showLineNumbers,
    })
    const lines = rendered === '' ? [] : rendered.split('\n')
    const { items: limitedResults, appliedLimit } = applyHeadLimit(
      lines,
      head_limit,
      offset,
    )
    // Same relativization as the rg branch (context lines keep their raw
    // path — the parser passes `path-line-text` lines through untouched).
    const finalLines = limitedResults.map(relativeContentLine)
    return {
      mode: 'content',
      numFiles: 0, // Not applicable for content mode
      filenames: [],
      content: finalLines.join('\n'),
      numLines: finalLines.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    }
  }

  if (output_mode === 'count') {
    // `rg -c FILE` (single-file target) prints a bare count; a directory
    // target prints `path:count` per file. Mirror both shapes.
    let bareCount = false
    try {
      const stats = await getFsImplementation().stat(absolutePath)
      bareCount = stats.isFile()
    } catch {
      bareCount = false
    }
    const rendered = renderGrepMatches(result.matches, {
      mode: 'Count',
      bareCount,
    })
    const renderedLines = rendered === '' ? [] : rendered.split('\n')
    const { items: limitedResults, appliedLimit } = applyHeadLimit(
      renderedLines,
      head_limit,
      offset,
    )

    // Same count-line relativization + total parsing as the rg branch.
    const finalCountLines = limitedResults.map(line => {
      const colonIndex = line.lastIndexOf(':')
      if (colonIndex > 0) {
        const filePath = line.substring(0, colonIndex)
        const count = line.substring(colonIndex)
        return toRelativePath(filePath) + count
      }
      return line
    })

    let totalMatches = 0
    let fileCount = 0
    for (const line of finalCountLines) {
      const colonIndex = line.lastIndexOf(':')
      if (colonIndex > 0) {
        const countStr = line.substring(colonIndex + 1)
        const count = parseInt(countStr, 10)
        if (!isNaN(count)) {
          totalMatches += count
          fileCount += 1
        }
      }
    }

    return {
      mode: 'count',
      numFiles: fileCount,
      filenames: [],
      content: finalCountLines.join('\n'),
      numMatches: totalMatches,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    }
  }

  // files_with_matches mode: native emits exactly one GrepMatch per matching
  // file. Sort by mtime like the rg branch (filename tiebreaker; under test,
  // plain filename sort for determinism).
  const allSettled = await Promise.allSettled(
    result.matches.map(_ => getFsImplementation().stat(_.path)),
  )
  const sortedMatches = result.matches
    .map((_, i) => {
      const r = allSettled[i]!
      return [
        _.path,
        r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0,
      ] as const
    })
    .sort((a, b) => {
      if (process.env.NODE_ENV === 'test') {
        return a[0].localeCompare(b[0])
      }
      const timeComparison = b[1] - a[1]
      if (timeComparison === 0) {
        return a[0].localeCompare(b[0])
      }
      return timeComparison
    })
    .map(_ => _[0])

  const { items: finalMatches, appliedLimit } = applyHeadLimit(
    sortedMatches,
    head_limit,
    offset,
  )
  const relativeMatches = finalMatches.map(toRelativePath)
  return {
    mode: 'files_with_matches',
    filenames: relativeMatches,
    numFiles: relativeMatches.length,
    ...(appliedLimit !== undefined && { appliedLimit }),
    ...(offset > 0 && { appliedOffset: offset }),
  }
}

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regex (ripgrep)',
  // 20K chars - tool result persistence threshold
  maxResultSizeChars: 20_000,
  strict: true,
  async description() {
    return getDescription()
  },
  userFacingName() {
    return 'Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  getPath({ path }): string {
    return path || getCwd()
  },
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  async validateInput({ path }): Promise<ValidationResult> {
    // If path is provided, validate that it exists
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      try {
        await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Path does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`
          }
          return {
            result: false,
            message,
            errorCode: 1,
          }
        }
        throw e
      }
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GrepTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return getDescription()
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // SearchResultSummary shows content (mode=content) or filenames.join.
  // numFiles/numLines/numMatches are chrome ("Found 3 files") — fine to
  // skip (under-count, not phantom). Glob reuses this via UI.tsx:65.
  extractSearchText({ mode, content, filenames }) {
    if (mode === 'content' && content) return content
    return filenames.join('\n')
  },
  mapToolResultToToolResultBlockParam(
    {
      mode = 'files_with_matches',
      numFiles,
      filenames,
      content,
      numLines: _numLines,
      numMatches,
      appliedLimit,
      appliedOffset,
    },
    toolUseID,
  ) {
    if (mode === 'content') {
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const resultContent = content || 'No matches found'
      const finalContent = limitInfo
        ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
        : resultContent
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: finalContent,
      }
    }

    if (mode === 'count') {
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const rawContent = content || 'No matches found'
      const matches = numMatches ?? 0
      const files = numFiles ?? 0
      const summary = `\n\nFound ${matches} total ${matches === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: rawContent + summary,
      }
    }

    // files_with_matches mode
    const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
    if (numFiles === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    // head_limit has already been applied in call() method, so just show all filenames
    const result = `Found ${numFiles} ${plural(numFiles, 'file')}${limitInfo ? ` ${limitInfo}` : ''}\n${filenames.join('\n')}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
  async call(
    {
      pattern,
      path,
      glob,
      type,
      output_mode = 'files_with_matches',
      '-B': context_before,
      '-A': context_after,
      '-C': context_c,
      context,
      '-n': show_line_numbers = true,
      '-i': case_insensitive = false,
      head_limit,
      offset = 0,
      multiline = false,
    },
    { abortController, getAppState },
  ) {
    // SEARCH_NAPI native-first dispatch — runs the in-process Rust engine
    // when the flag is on AND the native module is loadable/structurally
    // valid; otherwise (or on any native failure) falls through to the
    // byte-identical rg subprocess branch below, untouched.
    if (feature('SEARCH_NAPI')) {
      const native = await nativeGrepOutput(
        {
          pattern,
          path,
          glob,
          type,
          output_mode,
          context_before,
          context_after,
          context_c,
          context,
          showLineNumbers: show_line_numbers,
          case_insensitive,
          head_limit,
          offset,
          multiline,
        },
        { abortController, getAppState },
      )
      if (native !== null) {
        return { data: native }
      }
    }

    const absolutePath = path ? expandPath(path) : getCwd()
    const args = ['--hidden']

    // Exclude VCS directories to avoid noise from version control metadata
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push('--glob', `!${dir}`)
    }

    // Limit line length to prevent base64/minified content from cluttering output
    args.push('--max-columns', '500')

    // Only apply multiline flags when explicitly requested
    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }

    // Add optional flags
    if (case_insensitive) {
      args.push('-i')
    }

    // Add output mode flags
    if (output_mode === 'files_with_matches') {
      args.push('-l')
    } else if (output_mode === 'count') {
      args.push('-c')
    }

    // Add line numbers if requested
    if (show_line_numbers && output_mode === 'content') {
      args.push('-n')
    }

    // Add context flags (-C/context takes precedence over context_before/context_after)
    if (output_mode === 'content') {
      if (context !== undefined) {
        args.push('-C', context.toString())
      } else if (context_c !== undefined) {
        args.push('-C', context_c.toString())
      } else {
        if (context_before !== undefined) {
          args.push('-B', context_before.toString())
        }
        if (context_after !== undefined) {
          args.push('-A', context_after.toString())
        }
      }
    }

    // If pattern starts with dash, use -e flag to specify it as a pattern
    // This prevents ripgrep from interpreting it as a command-line option
    if (pattern.startsWith('-')) {
      args.push('-e', pattern)
    } else {
      args.push(pattern)
    }

    // Add type filter if specified
    if (type) {
      args.push('--type', type)
    }

    if (glob) {
      // Split on commas and spaces, but preserve patterns with braces
      const globPatterns: string[] = []
      const rawPatterns = glob.split(/\s+/)

      for (const rawPattern of rawPatterns) {
        // If pattern contains braces, don't split further
        if (rawPattern.includes('{') && rawPattern.includes('}')) {
          globPatterns.push(rawPattern)
        } else {
          // Split on commas for patterns without braces
          globPatterns.push(...rawPattern.split(',').filter(Boolean))
        }
      }

      for (const globPattern of globPatterns.filter(Boolean)) {
        args.push('--glob', globPattern)
      }
    }

    // Add ignore patterns
    const appState = getAppState()
    const ignorePatterns = normalizePatternsToPath(
      getFileReadIgnorePatterns(appState.toolPermissionContext),
      getCwd(),
    )
    for (const ignorePattern of ignorePatterns) {
      // Note: ripgrep only applies gitignore patterns relative to the working directory
      // So for non-absolute paths, we need to prefix them with '**'
      // See: https://github.com/BurntSushi/ripgrep/discussions/2156#discussioncomment-2316335
      //
      // We also need to negate the pattern with `!` to exclude it
      const rgIgnorePattern = ignorePattern.startsWith('/')
        ? `!${ignorePattern}`
        : `!**/${ignorePattern}`
      args.push('--glob', rgIgnorePattern)
    }

    // Exclude orphaned plugin version directories
    for (const exclusion of await getGlobExclusionsForPluginCache(
      absolutePath,
    )) {
      args.push('--glob', exclusion)
    }

    // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
    // The timeout is handled by ripgrep itself via execFile timeout option
    // We don't use AbortController for timeout to avoid interrupting the agent loop
    // If ripgrep times out, it throws RipgrepTimeoutError which propagates up
    // so Claude knows the search didn't complete (rather than thinking there were no matches)
    const results = await ripGrep(args, absolutePath, abortController.signal)

    if (output_mode === 'content') {
      // For content mode, results are the actual content lines
      // Convert absolute paths to relative paths to save tokens

      // Apply head_limit first — relativize is per-line work, so
      // avoid processing lines that will be discarded (broad patterns can
      // return 10k+ lines with head_limit keeping only ~30-100).
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      const finalLines = limitedResults.map(relativeContentLine)
      const output = {
        mode: 'content' as const,
        numFiles: 0, // Not applicable for content mode
        filenames: [],
        content: finalLines.join('\n'),
        numLines: finalLines.length,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      }
      return { data: output }
    }

    if (output_mode === 'count') {
      // For count mode, pass through raw ripgrep output (filename:count format)
      // Apply head_limit first to avoid relativizing entries that will be discarded.
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      // Convert absolute paths to relative paths to save tokens
      const finalCountLines = limitedResults.map(line => {
        // Lines have format: /absolute/path:count
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex)
          const count = line.substring(colonIndex)
          return toRelativePath(filePath) + count
        }
        return line
      })

      // Parse count output to extract total matches and file count
      let totalMatches = 0
      let fileCount = 0
      for (const line of finalCountLines) {
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const countStr = line.substring(colonIndex + 1)
          const count = parseInt(countStr, 10)
          if (!isNaN(count)) {
            totalMatches += count
            fileCount += 1
          }
        }
      }

      const output = {
        mode: 'count' as const,
        numFiles: fileCount,
        filenames: [],
        content: finalCountLines.join('\n'),
        numMatches: totalMatches,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      }
      return { data: output }
    }

    // For files_with_matches mode (default)
    // Use allSettled so a single ENOENT (file deleted between ripgrep's scan
    // and this stat) does not reject the whole batch. Failed stats sort as mtime 0.
    const stats = await Promise.allSettled(
      results.map(_ => getFsImplementation().stat(_)),
    )
    const sortedMatches = results
      // Sort by modification time
      .map((_, i) => {
        const r = stats[i]!
        return [
          _,
          r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0,
        ] as const
      })
      .sort((a, b) => {
        if (process.env.NODE_ENV === 'test') {
          // In tests, we always want to sort by filename, so that results are deterministic
          return a[0].localeCompare(b[0])
        }
        const timeComparison = b[1] - a[1]
        if (timeComparison === 0) {
          // Sort by filename as a tiebreaker
          return a[0].localeCompare(b[0])
        }
        return timeComparison
      })
      .map(_ => _[0])

    // Apply head_limit to sorted file list (like "| head -N")
    const { items: finalMatches, appliedLimit } = applyHeadLimit(
      sortedMatches,
      head_limit,
      offset,
    )

    // Convert absolute paths to relative paths to save tokens
    const relativeMatches = finalMatches.map(toRelativePath)

    const output = {
      mode: 'files_with_matches' as const,
      filenames: relativeMatches,
      numFiles: relativeMatches.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    }

    return {
      data: output,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
