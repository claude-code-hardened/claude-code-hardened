import {
  structuredPatch as colorDiffStructuredPatch,
  type StructuredPatchHunk,
} from 'color-diff-napi'
import { logEvent } from 'src/services/analytics/index.js'
import { getLocCounter } from '../bootstrap/state.js'
import { addToTotalLinesChanged } from '../cost-tracker.js'
import type { FileEdit } from '@claude-code-hardened/builtin-tools/tools/FileEditTool/types.js'
import { count } from './array.js'
import { convertLeadingTabsToSpaces } from './file.js'

export type { StructuredPatchHunk }

export const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

/**
 * Shifts hunk line numbers by offset. Use when getPatchForDisplay received
 * a slice of the file (e.g. readEditContext) rather than the whole file —
 * callers pass `ctx.lineOffset - 1` to convert slice-relative to file-relative.
 */
export function adjustHunkLineNumbers(
  hunks: StructuredPatchHunk[],
  offset: number,
): StructuredPatchHunk[] {
  if (offset === 0) return hunks
  return hunks.map(h => ({
    ...h,
    oldStart: h.oldStart + offset,
    newStart: h.newStart + offset,
  }))
}

// For some reason, & confuses the diff library, so we replace it with a token,
// then substitute it back in after the diff is computed.
const AMPERSAND_TOKEN = '<<:AMPERSAND_TOKEN:>>'

const DOLLAR_TOKEN = '<<:DOLLAR_TOKEN:>>'

function escapeForDiff(s: string): string {
  return s.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN)
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, '&').replaceAll(DOLLAR_TOKEN, '$')
}

/**
 * Count lines added and removed in a patch and update the total
 * For new files, pass the content string as the second parameter
 * @param patch Array of diff hunks
 * @param newFileContent Optional content string for new files
 */
export function countLinesChanged(
  patch: StructuredPatchHunk[],
  newFileContent?: string,
): void {
  let numAdditions = 0
  let numRemovals = 0

  if (patch.length === 0 && newFileContent) {
    // For new files, count all lines as additions
    numAdditions = newFileContent.split(/\r?\n/).length
  } else {
    numAdditions = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('+')),
      0,
    )
    numRemovals = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('-')),
      0,
    )
  }

  addToTotalLinesChanged(numAdditions, numRemovals)

  getLocCounter()?.add(numAdditions, { type: 'added' })
  getLocCounter()?.add(numRemovals, { type: 'removed' })

  logEvent('tengu_file_changed', {
    lines_added: numAdditions,
    lines_removed: numRemovals,
  })
}

export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
  context = CONTEXT_LINES,
}: {
  filePath: string
  oldContent: string
  newContent: string
  ignoreWhitespace?: boolean
  singleHunk?: boolean
  context?: number
}): StructuredPatchHunk[] {
  const result = colorDiffStructuredPatch(
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    {
      ignoreWhitespace,
      context: singleHunk ? 100_000 : context,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  if (!result) {
    return []
  }
  return result.hunks.map(_ => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }))
}

/**
 * Get a patch for display with edits applied
 * @param filePath The path to the file
 * @param fileContents The contents of the file
 * @param edits An array of edits to apply to the file
 * @param ignoreWhitespace Whether to ignore whitespace changes
 * @returns An array of hunks representing the diff
 *
 * NOTE: This function will return the diff with all leading tabs
 * rendered as spaces for display
 */

export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace = false,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
  ignoreWhitespace?: boolean
}): StructuredPatchHunk[] {
  const preparedFileContents = escapeForDiff(
    convertLeadingTabsToSpaces(fileContents),
  )
  const result = colorDiffStructuredPatch(
    preparedFileContents,
    edits.reduce((p, edit) => {
      const { old_string, new_string } = edit
      const replace_all = 'replace_all' in edit ? edit.replace_all : false
      const escapedOldString = escapeForDiff(
        convertLeadingTabsToSpaces(old_string),
      )
      const escapedNewString = escapeForDiff(
        convertLeadingTabsToSpaces(new_string),
      )

      if (replace_all) {
        return p.replaceAll(escapedOldString, () => escapedNewString)
      } else {
        return p.replace(escapedOldString, () => escapedNewString)
      }
    }, preparedFileContents),
    {
      context: CONTEXT_LINES,
      ignoreWhitespace,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  if (!result) {
    return []
  }
  return result.hunks.map(_ => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }))
}

// ---------------------------------------------------------------------------
// Unified-diff text generation (jsdiff createPatch/formatPatch port)
// ---------------------------------------------------------------------------

/**
 * Port of jsdiff's formatPatch header/hunk rendering (INCLUDE_HEADERS
 * default): Index header, underline, ---/+++ file headers, then
 * `@@ -oldStart,oldLines +newStart,newLines @@` per hunk with the
 * chunk-size-0 start adjustment quirk applied.
 */
function formatPatch(
  hunks: StructuredPatchHunk[],
  fileName: string,
  oldHeader?: string,
  newHeader?: string,
): string {
  const ret: string[] = []
  ret.push(`Index: ${fileName}`)
  ret.push(
    '===================================================================',
  )
  ret.push(`--- ${fileName}${oldHeader === undefined ? '' : `\t${oldHeader}`}`)
  ret.push(`+++ ${fileName}${newHeader === undefined ? '' : `\t${newHeader}`}`)
  for (const hunk of hunks) {
    // Unified Diff Format quirk: If the chunk size is 0, the first number is
    // one lower than one would expect.
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart
    ret.push(
      `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`,
    )
    ret.push(...hunk.lines)
  }
  return `${ret.join('\n')}\n`
}

/**
 * jsdiff `createPatch(fileName, oldStr, newStr, oldHeader, newHeader)`
 * equivalent: renders a unified diff patch string. Returns undefined when
 * the diff times out (parity with jsdiff's abort behavior).
 */
export function createPatch(
  fileName: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
): string | undefined {
  const result = colorDiffStructuredPatch(oldStr, newStr, {
    context: 4,
    timeout: DIFF_TIMEOUT_MS,
  })
  if (!result) {
    return undefined
  }
  return formatPatch(result.hunks, fileName, oldHeader, newHeader)
}
