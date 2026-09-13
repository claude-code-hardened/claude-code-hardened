/**
 * Pure-TypeScript port of the jsdiff (`diff` npm package) v8.0.4 subset this
 * repo uses: diffLines, diffWordsWithSpace, diffArrays (string tokens) and
 * structuredPatch hunk assembly. This exists so the `diff` dependency can be
 * removed — the native (Rust/similar) implementations are preferred at
 * runtime and this module is the always-reachable fallback.
 *
 * The Myers diff, tokenizers and hunk assembly below are line-for-line ports
 * of jsdiff 8.0.4 (MIT): diff/base.js, diff/line.js, diff/word.js,
 * diff/array.js, patch/create.js, util/string.js. Deviating from those
 * sources changes hunk output in observable ways, so keep them in sync.
 *
 * This module is also the JS reference implementation for
 * scripts/differential.ts (native structuredPatch vs pure-JS parity check).
 */

export type JsChange = {
  value: string
  count: number
  added: boolean
  removed: boolean
}

export type JsStructuredPatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

// ---------------------------------------------------------------------------
// diff/base.js port — Myers diff over string tokens
// ---------------------------------------------------------------------------

type Component = {
  count: number
  added: boolean
  removed: boolean
  value?: string
  previousComponent?: Component
}

type Path = { oldPos: number; lastComponent?: Component }

export type DiffTokenOptions = {
  ignoreCase?: boolean
  maxEditLength?: number
  /** Milliseconds; the diff bails (returns undefined) past the deadline. */
  timeout?: number
}

function addToPath(
  path: Path,
  added: boolean,
  removed: boolean,
  oldPosInc: number,
): Path {
  const last = path.lastComponent
  if (last && last.added === added && last.removed === removed) {
    return {
      oldPos: path.oldPos + oldPosInc,
      lastComponent: {
        count: last.count + 1,
        added,
        removed,
        previousComponent: last.previousComponent,
      },
    }
  }
  return {
    oldPos: path.oldPos + oldPosInc,
    lastComponent: { count: 1, added, removed, previousComponent: last },
  }
}

function extractCommon(
  basePath: Path,
  newTokens: string[],
  oldTokens: string[],
  diagonalPath: number,
  equals: (left: string, right: string) => boolean,
): number {
  const newLen = newTokens.length
  const oldLen = oldTokens.length
  let oldPos = basePath.oldPos
  let newPos = oldPos - diagonalPath
  let commonCount = 0
  while (
    newPos + 1 < newLen &&
    oldPos + 1 < oldLen &&
    equals(oldTokens[oldPos + 1]!, newTokens[newPos + 1]!)
  ) {
    newPos++
    oldPos++
    commonCount++
  }
  if (commonCount) {
    basePath.lastComponent = {
      count: commonCount,
      previousComponent: basePath.lastComponent,
      added: false,
      removed: false,
    }
  }
  basePath.oldPos = oldPos
  return newPos
}

function buildValues(
  lastComponent: Component | undefined,
  newTokens: string[],
  oldTokens: string[],
  join: (tokens: string[]) => string,
): JsChange[] {
  const components: Component[] = []
  let nextComponent: Component | undefined = lastComponent
  while (nextComponent) {
    const current = nextComponent
    components.push(current)
    nextComponent = current.previousComponent
    delete current.previousComponent
  }
  components.reverse()

  let componentPos = 0
  let newPos = 0
  let oldPos = 0
  for (; componentPos < components.length; componentPos++) {
    const component = components[componentPos]!
    if (!component.removed) {
      component.value = join(newTokens.slice(newPos, newPos + component.count))
      newPos += component.count
      if (!component.added) {
        oldPos += component.count
      }
    } else {
      component.value = join(oldTokens.slice(oldPos, oldPos + component.count))
      oldPos += component.count
    }
  }
  return components.map(c => ({
    value: c.value ?? '',
    count: c.count,
    added: c.added,
    removed: c.removed,
  }))
}

/**
 * Port of jsdiff's Diff#diffWithOptionsObj (sync mode). Returns undefined
 * when maxEditLength is exceeded or the deadline passes.
 */
function diffTokens(
  oldTokens: string[],
  newTokens: string[],
  equals: (left: string, right: string) => boolean,
  join: (tokens: string[]) => string,
  options: DiffTokenOptions,
): JsChange[] | undefined {
  const newLen = newTokens.length
  const oldLen = oldTokens.length
  let editLength = 1
  let maxEditLength = newLen + oldLen
  if (options.maxEditLength != null) {
    maxEditLength = Math.min(maxEditLength, options.maxEditLength)
  }
  const abortAfterTimestamp =
    options.timeout !== undefined
      ? Date.now() + options.timeout
      : Number.POSITIVE_INFINITY

  const bestPath: (Path | undefined)[] = [
    { oldPos: -1, lastComponent: undefined },
  ]

  const finish = (path: Path): JsChange[] =>
    buildValues(path.lastComponent, newTokens, oldTokens, join)

  // Seed editLength = 0, i.e. the content starts with the same values
  const seedPos = extractCommon(bestPath[0]!, newTokens, oldTokens, 0, equals)
  if (bestPath[0]!.oldPos + 1 >= oldLen && seedPos + 1 >= newLen) {
    return finish(bestPath[0]!)
  }

  let minDiagonalToConsider = Number.NEGATIVE_INFINITY
  let maxDiagonalToConsider = Number.POSITIVE_INFINITY

  // Checks all permutations of a given edit length. Returns the result on
  // completion, or undefined to keep iterating.
  const execEditLength = (): JsChange[] | undefined => {
    for (
      let diagonalPath = Math.max(minDiagonalToConsider, -editLength);
      diagonalPath <= Math.min(maxDiagonalToConsider, editLength);
      diagonalPath += 2
    ) {
      const removePath = bestPath[diagonalPath - 1]
      const addPath = bestPath[diagonalPath + 1]
      if (removePath) {
        bestPath[diagonalPath - 1] = undefined
      }
      let addPathNewPos = Number.NaN
      if (addPath) {
        addPathNewPos = addPath.oldPos - diagonalPath
      }
      const canAdd = !!addPath && 0 <= addPathNewPos && addPathNewPos < newLen
      const canRemove = !!removePath && removePath.oldPos + 1 < oldLen
      if (!canAdd && !canRemove) {
        bestPath[diagonalPath] = undefined
        continue
      }
      const basePath =
        !canRemove || (canAdd && removePath!.oldPos < addPath!.oldPos)
          ? addToPath(addPath!, true, false, 0)
          : addToPath(removePath!, false, true, 1)
      const newPos = extractCommon(
        basePath,
        newTokens,
        oldTokens,
        diagonalPath,
        equals,
      )
      if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
        return finish(basePath)
      }
      bestPath[diagonalPath] = basePath
      if (basePath.oldPos + 1 >= oldLen) {
        maxDiagonalToConsider = Math.min(
          maxDiagonalToConsider,
          diagonalPath - 1,
        )
      }
      if (newPos + 1 >= newLen) {
        minDiagonalToConsider = Math.max(
          minDiagonalToConsider,
          diagonalPath + 1,
        )
      }
    }
    editLength++
    return undefined
  }

  while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
    const ret = execEditLength()
    if (ret) {
      return ret
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// diff/line.js port
// ---------------------------------------------------------------------------

/**
 * Split text into line tokens, each including its trailing newline (where
 * present) — identical to jsdiff's line tokenizer.
 */
export function tokenizeLines(
  value: string,
  stripTrailingCr = false,
): string[] {
  if (stripTrailingCr) {
    value = value.replace(/\r\n/g, '\n')
  }
  const retLines: string[] = []
  const linesAndNewlines = value.split(/(\n|\r\n)/)
  // Ignore the final empty token that occurs if the string ends with a newline
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop()
  }
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i]!
    if (i % 2) {
      retLines[retLines.length - 1] += line
    } else {
      retLines.push(line)
    }
  }
  return retLines
}

export type DiffLinesOptions = DiffTokenOptions & {
  ignoreWhitespace?: boolean
  stripTrailingCr?: boolean
}

/** Port of jsdiff's diffLines. Returns undefined on timeout/maxEditLength. */
export function jsDiffLines(
  oldStr: string,
  newStr: string,
  options: DiffLinesOptions = {},
): JsChange[] | undefined {
  const equals = (left: string, right: string): boolean => {
    let l = left
    let r = right
    if (options.ignoreWhitespace) {
      l = l.trim()
      r = r.trim()
    }
    if (options.ignoreCase) {
      return l.toLowerCase() === r.toLowerCase()
    }
    return l === r
  }
  const oldTokens = tokenizeLines(oldStr, options.stripTrailingCr).filter(
    t => t !== '',
  )
  const newTokens = tokenizeLines(newStr, options.stripTrailingCr).filter(
    t => t !== '',
  )
  return diffTokens(
    oldTokens,
    newTokens,
    equals,
    tokens => tokens.join(''),
    options,
  )
}

// ---------------------------------------------------------------------------
// diff/word.js port (WordsWithSpaceDiff — no whitespace dedupe postProcess)
// ---------------------------------------------------------------------------

// Based on https://en.wikipedia.org/wiki/Latin_script_in_Unicode — the exact
// character classes jsdiff's word tokenizer treats as "word" characters.
const EXTENDED_WORD_CHARS =
  'a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}'

// Each newline is its own token; whitespace runs (sans newlines) attach to
// their surrounding token via jsdiff's regex grouping.
const WORDS_WITH_SPACE_TOKEN_RE = new RegExp(
  `(\\r?\\n)|[${EXTENDED_WORD_CHARS}]+|[^\\S\\n\\r]+|[^${EXTENDED_WORD_CHARS}]`,
  'ug',
)

/** Port of jsdiff's diffWordsWithSpace (exact token equality, plain join). */
export function jsDiffWordsWithSpace(
  oldStr: string,
  newStr: string,
  options: DiffTokenOptions = {},
): JsChange[] | undefined {
  const oldTokens = oldStr.match(WORDS_WITH_SPACE_TOKEN_RE) ?? []
  const newTokens = newStr.match(WORDS_WITH_SPACE_TOKEN_RE) ?? []
  return diffTokens(
    oldTokens,
    newTokens,
    (left, right) =>
      options.ignoreCase
        ? left.toLowerCase() === right.toLowerCase()
        : left === right,
    tokens => tokens.join(''),
    options,
  )
}

// ---------------------------------------------------------------------------
// diff/array.js port (string tokens only)
// ---------------------------------------------------------------------------

export type JsArrayChange = {
  value: string[]
  count: number
  added: boolean
  removed: boolean
}

/** Port of jsdiff's diffArrays for string-token arrays. */
export function jsDiffArraysString(
  oldArr: string[],
  newArr: string[],
  options: DiffTokenOptions = {},
): JsArrayChange[] | undefined {
  const result = diffTokens(
    oldArr.slice(),
    newArr.slice(),
    (left, right) => left === right,
    tokens => tokens.join(''),
    options,
  )
  if (!result) {
    return undefined
  }
  // Rebuild values as token arrays — buildValues joined them only to satisfy
  // the string Change shape, so re-slice from the inputs instead.
  const changes: JsArrayChange[] = []
  let newPos = 0
  let oldPos = 0
  for (const change of result) {
    const count = change.count
    if (change.added) {
      changes.push({
        value: newArr.slice(newPos, newPos + count),
        count,
        added: true,
        removed: false,
      })
      newPos += count
    } else if (change.removed) {
      changes.push({
        value: oldArr.slice(oldPos, oldPos + count),
        count,
        added: false,
        removed: true,
      })
      oldPos += count
    } else {
      changes.push({
        value: newArr.slice(newPos, newPos + count),
        count,
        added: false,
        removed: false,
      })
      newPos += count
      oldPos += count
    }
  }
  return changes
}

// ---------------------------------------------------------------------------
// patch/create.js port — structuredPatch hunk assembly
// ---------------------------------------------------------------------------

/**
 * Split a change value into lines including the trailing newline character
 * (where present) — port of jsdiff's splitLines in patch/create.js.
 */
export function splitChangeLines(value: string): string[] {
  const hasTrailingNl = value.endsWith('\n')
  const result = value.split('\n').map(line => line + '\n')
  if (hasTrailingNl) {
    result.pop()
  } else {
    const last = result.pop() ?? ''
    result.push(last.slice(0, -1))
  }
  return result
}

type PatchEntry = {
  added: boolean
  removed: boolean
  lines: string[]
}

/**
 * Port of jsdiff's diffLinesResultToPatch: assembles unified-diff hunks from
 * a diffLines result, including the "\ No newline at end of file" markers
 * jsdiff appends in its second pass.
 */
export function structuredPatchFromChanges(
  changes: JsChange[],
  context: number,
): JsStructuredPatchHunk[] {
  const diff: PatchEntry[] = changes.map(c => ({
    added: c.added,
    removed: c.removed,
    lines: splitChangeLines(c.value),
  }))
  // Append an empty value to make cleanup easier (jsdiff does the same)
  diff.push({ added: false, removed: false, lines: [] })

  const hunks: JsStructuredPatchHunk[] = []
  let oldRangeStart = 0
  let newRangeStart = 0
  let curRange: string[] = []
  let oldLine = 1
  let newLine = 1

  for (let i = 0; i < diff.length; i++) {
    const current = diff[i]!
    const lines = current.lines
    if (current.added || current.removed) {
      // If we have previous context, start with that
      if (oldRangeStart === 0) {
        const prev = i > 0 ? diff[i - 1] : undefined
        oldRangeStart = oldLine
        newRangeStart = newLine
        if (prev) {
          curRange =
            context > 0
              ? prev.lines.slice(-context).map(entry => ' ' + entry)
              : []
          oldRangeStart -= curRange.length
          newRangeStart -= curRange.length
        }
      }
      // Output our changes
      for (const line of lines) {
        curRange.push((current.added ? '+' : '-') + line)
      }
      // Track the updated file position
      if (current.added) {
        newLine += lines.length
      } else {
        oldLine += lines.length
      }
    } else {
      // Identical context lines. Track line changes
      if (oldRangeStart !== 0) {
        // Close out any changes that have been output (or join overlapping)
        if (lines.length <= context * 2 && i < diff.length - 2) {
          // Overlapping
          for (const line of lines) {
            curRange.push(' ' + line)
          }
        } else {
          // End the range and output it
          const contextSize = Math.min(lines.length, context)
          for (const line of lines.slice(0, contextSize)) {
            curRange.push(' ' + line)
          }
          hunks.push({
            oldStart: oldRangeStart,
            oldLines: oldLine - oldRangeStart + contextSize,
            newStart: newRangeStart,
            newLines: newLine - newRangeStart + contextSize,
            lines: curRange,
          })
          oldRangeStart = 0
          newRangeStart = 0
          curRange = []
        }
      }
      oldLine += lines.length
      newLine += lines.length
    }
  }

  // Step 2: eliminate the trailing \n from each line of each hunk, and, where
  // needed, add "\ No newline at end of file".
  for (const hunk of hunks) {
    const out: string[] = []
    for (const line of hunk.lines) {
      if (line.endsWith('\n')) {
        out.push(line.slice(0, -1))
      } else {
        out.push(line)
        out.push('\\ No newline at end of file')
      }
    }
    hunk.lines = out
  }
  return hunks
}

export type JsStructuredPatchOptions = {
  context?: number
  ignoreWhitespace?: boolean
  timeout?: number
}

/**
 * Port of jsdiff's structuredPatch (hunks only). Returns undefined on
 * timeout — callers treat that as "no patch".
 */
export function jsStructuredPatch(
  oldStr: string,
  newStr: string,
  options: JsStructuredPatchOptions = {},
): JsStructuredPatchHunk[] | undefined {
  const context = options.context ?? 4
  const changes = jsDiffLines(oldStr, newStr, options)
  if (!changes) {
    return undefined
  }
  return structuredPatchFromChanges(changes, context)
}
