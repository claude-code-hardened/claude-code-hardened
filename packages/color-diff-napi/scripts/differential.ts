#!/usr/bin/env bun
/**
 * Differential test: native structuredPatch/diffLines (Rust/similar) vs the
 * pure-JS jsdiff port in ../src/jsDiff.ts — hunk-by-hunk parity over a
 * deterministic generated corpus plus (optionally) real files. Zero npm
 * dependencies (only bun + the .node artifact) so it runs anywhere without
 * a node_modules.
 *
 * Usage:
 *   bun run packages/color-diff-napi/scripts/differential.ts \
 *     <path-to-color-diff.node> [--strict] [--cases N] [file-or-dir ...]
 *
 * With paths, each text file is additionally used as old-text seed for
 * mutation rounds. Exit 0 = no hard failures. Outcomes:
 *   match       — native hunks are byte-identical to the JS reference
 *   divergence  — hunks differ but both sides reconstruct old→new exactly
 *                 (equally minimal edit scripts; similar's Myers may pick a
 *                 different tie-break than jsdiff's). --strict turns these
 *                 into failures.
 *   FAIL        — reconstruction broken or added/removed counts differ.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  jsDiffLines,
  jsStructuredPatch,
  type JsStructuredPatchHunk,
} from '../src/jsDiff'

// ---------------------------------------------------------------------------
// Native module loading
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const casesIdx = argv.indexOf('--cases')
const caseCount = casesIdx >= 0 ? Number(argv[casesIdx + 1]) || 2000 : 2000
const casesValue = casesIdx >= 0 ? argv[casesIdx + 1] : undefined
const nodePath = argv.find(a => !a.startsWith('--') && a !== casesValue)
if (!nodePath || !existsSync(nodePath)) {
  console.error(
    'usage: differential.ts <color-diff.node> [--strict] [--cases N] [paths...]',
  )
  process.exit(2)
}
const nodeRequire = createRequire(import.meta.url)
const napi = nodeRequire(nodePath) as {
  structuredPatch?: (
    oldStr: string,
    newStr: string,
    context?: number,
  ) => JsStructuredPatchHunk[]
  diffLines?: (oldStr: string, newStr: string) => unknown[]
}
if (typeof napi.structuredPatch !== 'function') {
  console.error(
    'native module has no structuredPatch — rebuild with the current lib.rs',
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Deterministic PRNG + corpus
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCAB = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'x',
  'y',
  '42',
  'foo()',
  'bar = 1',
  '{',
  '}',
  '  indented',
  '\tTABBED',
  'ünïcödé',
  'a & b',
  '$dollar',
  '',
  'function call(arg) {',
  'return value;',
  '// comment with & and $',
]
// Lone \r is a documented tokenizer divergence (similar treats it as a line
// terminator, jsdiff does not) — exclude it from generated corpus.

function randText(rnd: () => number, maxLines: number): string {
  const n = Math.floor(rnd() * maxLines)
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(VOCAB[Math.floor(rnd() * VOCAB.length)]!)
  }
  let s = lines.join('\n')
  if (s.length > 0 && rnd() < 0.5) s += '\n'
  return s
}

function mutate(rnd: () => number, s: string): string {
  let lines = s.length > 0 ? s.split('\n') : []
  const ops = Math.floor(rnd() * 8)
  for (let i = 0; i < ops; i++) {
    const r = rnd()
    if (r < 0.35 || lines.length === 0) {
      lines.splice(
        Math.floor(rnd() * (lines.length + 1)),
        0,
        VOCAB[Math.floor(rnd() * VOCAB.length)]!,
      )
    } else if (r < 0.7) {
      lines.splice(Math.floor(rnd() * lines.length), 1)
    } else {
      lines[Math.floor(rnd() * lines.length)] =
        VOCAB[Math.floor(rnd() * VOCAB.length)]!
    }
  }
  let out = lines.join('\n')
  if (out.length > 0 && rnd() < 0.5) out += '\n'
  return out
}

const CONTEXTS = [0, 1, 2, 3, 4, 8, 100_000]

const EDGE_CASES: [string, string][] = [
  ['', ''],
  ['', 'new content'],
  ['old content', ''],
  ['hello\nworld', 'hello\nplanet'],
  ['same', 'same'],
  ['a\nb\nc\nd\ne\nf\ng', 'a\nb\nX\nd\ne\nY\ng'],
  ['x', 'x\ny'],
  ['x\n', 'x'],
  ['a', 'b'],
  ['a\nb', 'b\na'],
  ['a\r\nb', 'a\nb'],
  ['foo\nbar\nbaz\nqux', 'foo\nbaz'],
  [
    'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9',
    'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10',
  ],
  ['ü\né\nü', 'é\nü'],
  ['end\nwithout', 'end\nwithout newline here'],
  ['\n\n\n', '\n\n'],
  ['only', 'only\n'],
]

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

const seedFiles: string[] = []
function collect(p: string): void {
  let st: import('node:fs').Stats
  try {
    st = statSync(p)
  } catch {
    return
  }
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) collect(join(p, e))
  } else if (st.isFile() && st.size > 0 && st.size < 1_000_000) {
    try {
      const text = readFileSync(p, 'utf-8')
      if (!text.includes('\r') || !text.replace(/\r\n/g, '').includes('\r')) {
        seedFiles.push(p)
      }
    } catch {
      // non-UTF8 / unreadable — skip
    }
  }
}
for (const p of argv) {
  if (p === '--strict' || p === '--cases' || p === casesValue) continue
  if (p === nodePath) continue
  collect(p)
}

// ---------------------------------------------------------------------------
// Invariant: applying hunks to old yields new (line-level, modulo the
// trailing-newline state which hunk lines cannot fully express)
// ---------------------------------------------------------------------------

function toLines(s: string): string[] {
  if (s === '') return []
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n')
}

function reconstruct(
  oldText: string,
  hunks: JsStructuredPatchHunk[],
): string[] | null {
  const old = toLines(oldText)
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    const start = h.oldStart - 1
    if (!Number.isInteger(start) || start < pos || start > old.length)
      return null
    while (pos < start) out.push(old[pos++]!)
    for (const line of h.lines) {
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      const marker = line.slice(0, 1)
      const content = line.slice(1)
      if (marker === ' ' || marker === '-') {
        if (pos >= old.length || old[pos] !== content) return null
        if (marker === ' ') out.push(old[pos]!)
        pos++
      } else if (marker === '+') {
        out.push(content)
      } else {
        return null
      }
    }
  }
  while (pos < old.length) out.push(old[pos++]!)
  return out
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

let matched = 0
let diverged = 0
let failed = 0
let checkedDiffLines = 0
const failures: string[] = []

function noteFailure(
  kind: string,
  oldStr: string,
  newStr: string,
  context: number,
  detail: string,
): void {
  failed++
  if (failures.length < 5) {
    failures.push(
      `FAIL ${kind} (ctx=${context})\n  old=${JSON.stringify(oldStr)}\n  new=${JSON.stringify(newStr)}\n  ${detail}`,
    )
  }
}

function compareCase(oldStr: string, newStr: string, context: number): void {
  const expected = jsStructuredPatch(oldStr, newStr, { context }) ?? []
  let got: JsStructuredPatchHunk[] | undefined
  try {
    got = napi.structuredPatch!(oldStr, newStr, context)
  } catch (e) {
    noteFailure('structuredPatch threw', oldStr, newStr, context, String(e))
    return
  }
  got = got ?? []
  if (JSON.stringify(got) === JSON.stringify(expected)) {
    matched++
  } else {
    // Not byte-identical: both must still be valid minimal diffs that
    // transform old into new, with identical added/removed totals.
    const expRe = reconstruct(oldStr, expected)
    const gotRe = reconstruct(oldStr, got)
    if (expRe === null || gotRe === null) {
      noteFailure(
        'structuredPatch invalid hunks',
        oldStr,
        newStr,
        context,
        `js-reconstruct=${expRe === null ? 'BROKEN' : 'ok'} native-reconstruct=${gotRe === null ? 'BROKEN' : 'ok'}`,
      )
      return
    }
    const expNew = toLines(newStr)
    if (
      JSON.stringify(expRe) !== JSON.stringify(expNew) ||
      JSON.stringify(gotRe) !== JSON.stringify(expNew)
    ) {
      noteFailure(
        'structuredPatch reconstruction mismatch',
        oldStr,
        newStr,
        context,
        'reconstructed text != new text',
      )
      return
    }
    const totals = (hunks: JsStructuredPatchHunk[]): [number, number] => {
      let a = 0
      let r = 0
      for (const h of hunks) {
        for (const l of h.lines) {
          if (l.startsWith('+')) a++
          else if (l.startsWith('-')) r++
        }
      }
      return [a, r]
    }
    if (JSON.stringify(totals(got)) !== JSON.stringify(totals(expected))) {
      noteFailure(
        'structuredPatch edit-distance mismatch',
        oldStr,
        newStr,
        context,
        'non-minimal diff',
      )
      return
    }
    diverged++
  }

  // Bonus: diffLines parity (added/removed totals must be identical; the
  // change sequence may differ on Myers tie-breaks).
  if (typeof napi.diffLines === 'function') {
    const jsChanges = jsDiffLines(oldStr, newStr) ?? []
    try {
      const rsChanges = (napi.diffLines!(oldStr, newStr) ?? []) as Array<{
        added?: boolean
        removed?: boolean
        count?: number
      }>
      const sum = (arr: typeof jsChanges, pick: 'added' | 'removed'): number =>
        arr.reduce((s, c) => s + (c[pick] ? c.count || 0 : 0), 0)
      if (
        sum(jsChanges, 'added') !== sum(rsChanges, 'added') ||
        sum(jsChanges, 'removed') !== sum(rsChanges, 'removed')
      ) {
        noteFailure(
          'diffLines counts mismatch',
          oldStr,
          newStr,
          context,
          'native/jsdiff added-removed totals differ',
        )
        return
      }
      checkedDiffLines++
    } catch (e) {
      noteFailure('diffLines threw', oldStr, newStr, context, String(e))
    }
  }
}

const rnd = mulberry32(20260913)
for (const [o, n] of EDGE_CASES) {
  for (const c of CONTEXTS) compareCase(o, n, c)
}
for (let i = 0; i < caseCount; i++) {
  const o = randText(rnd, 200)
  const n = mutate(rnd, o)
  compareCase(o, n, CONTEXTS[Math.floor(rnd() * CONTEXTS.length)]!)
}
const fileRnd = mulberry32(424242)
for (const f of seedFiles) {
  let text: string | null = null
  try {
    text = readFileSync(f, 'utf-8')
  } catch {
    continue
  }
  if (text === null || text.length === 0 || text.length > 1_000_000) continue
  for (let i = 0; i < 3; i++) {
    compareCase(
      text,
      mutate(fileRnd, text),
      CONTEXTS[Math.floor(fileRnd() * CONTEXTS.length)]!,
    )
  }
}

const total = matched + diverged + failed
console.log(
  `differential: ${total} cases — ${matched} match, ${diverged} divergence` +
    `${strict ? '' : ' (allowed)'}, ${failed} fail` +
    `; diffLines totals compared on ${checkedDiffLines}`,
)
if (failures.length > 0) console.log(failures.join('\n---\n'))
process.exit(failed === 0 && (!strict || diverged === 0) ? 0 : 1)
