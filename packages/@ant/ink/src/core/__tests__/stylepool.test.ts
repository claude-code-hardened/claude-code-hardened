import type { AnsiCode } from '@alcalzone/ansi-tokenize'
import { describe, expect, test } from 'bun:test'
import type { Frame } from '../frame.js'
import { LogUpdate } from '../log-update.js'
import {
  cellAt,
  CellWidth,
  CharPool,
  createScreen,
  diff,
  HyperlinkPool,
  STYLE_POOL_RESET_SIZE,
  type Screen,
  setCellAt,
  StylePool,
} from '../screen.js'
import Output from '../output.js'

// Style fixtures — the AnsiCode shape used across the ink core.
const RED_FG: AnsiCode[] = [
  { type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' },
]
const BLUE_BOLD: AnsiCode[] = [
  { type: 'ansi', code: '\x1b[34m', endCode: '\x1b[39m' },
  { type: 'ansi', code: '\x1b[1m', endCode: '\x1b[22m' },
]
const GREY_BG: AnsiCode[] = [
  { type: 'ansi', code: '\x1b[48;5;236m', endCode: '\x1b[49m' },
]
const MAGENTA_256: AnsiCode[] = [
  { type: 'ansi', code: '\x1b[38;5;201m', endCode: '\x1b[39m' },
]

type PaintedCell = {
  x: number
  y: number
  char: string
  codes: AnsiCode[]
  hyperlink?: string
  wide?: boolean
}

// Shared content spec used across epoch boundaries so both epochs paint
// the exact same visual cells. Mixed fg-only (even id), bg (odd id),
// hyperlink, wide char (auto SpacerTail) and unstyled cells.
const CONTENT: PaintedCell[] = [
  { x: 0, y: 0, char: 'e', codes: RED_FG },
  { x: 1, y: 0, char: 'r', codes: RED_FG },
  { x: 2, y: 0, char: 'r', codes: RED_FG },
  { x: 3, y: 0, char: ' ', codes: GREY_BG },
  { x: 4, y: 0, char: 'o', codes: BLUE_BOLD },
  { x: 5, y: 0, char: 'k', codes: BLUE_BOLD },
  { x: 0, y: 1, char: '本', codes: [], wide: true },
  { x: 2, y: 1, char: 'l', codes: [] },
  { x: 3, y: 1, char: 'i', codes: [], hyperlink: 'https://example.com' },
  { x: 4, y: 1, char: 'n', codes: [] },
  { x: 6, y: 2, char: 'x', codes: MAGENTA_256 },
]

const WIDTH = 10
const HEIGHT = 4

function paintContent(
  pool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Screen {
  const screen = createScreen(WIDTH, HEIGHT, pool, charPool, hyperlinkPool)
  for (const c of CONTENT) {
    setCellAt(screen, c.x, c.y, {
      char: c.char,
      styleId: pool.intern(c.codes),
      width: c.wide ? CellWidth.Wide : CellWidth.Narrow,
      hyperlink: c.hyperlink,
    })
  }
  return screen
}

function frameOf(screen: Screen): Frame {
  return {
    screen,
    viewport: { width: WIDTH, height: HEIGHT + 1 },
    cursor: { x: 0, y: screen.height, visible: true },
  }
}

// LogUpdate's non-TTY path serializes the full frame through the pool
// (renderFullFrame) — this is the production diff-read path for style ids.
function renderFrameToString(
  log: LogUpdate,
  pool: StylePool,
  screen: Screen,
): string {
  const empty = createScreen(0, 0, pool, new CharPool(), new HyperlinkPool())
  const prev: Frame = {
    screen: empty,
    viewport: { width: WIDTH, height: HEIGHT + 1 },
    cursor: { x: 0, y: 0, visible: true },
  }
  const patches = log.render(prev, frameOf(screen), false)
  expect(patches).toHaveLength(1)
  expect(patches[0]!.type).toBe('stdout')
  return (patches[0] as { type: 'stdout'; content: string }).content
}

function codesToString(codes: AnsiCode[]): string {
  return codes.map(c => c.code).join(',')
}

describe('StylePool.reset() — generational rebuild', () => {
  test('re-interning the same styles after reset yields equivalent styles and transitions', () => {
    const pool = new StylePool()
    const plainScreen = createScreen(
      2,
      1,
      pool,
      new CharPool(),
      new HyperlinkPool(),
    )

    const redId = pool.intern(RED_FG)
    const boldId = pool.intern(BLUE_BOLD)
    const baselineRed = pool.get(redId).map(c => c.code)
    const baselineBold = pool.get(boldId).map(c => c.code)
    const baselineTransition = pool.transition(pool.none, redId)
    const baselineInverse = pool.get(pool.withInverse(redId)).map(c => c.code)

    pool.reset(plainScreen)

    // Fresh epoch re-interns in the same order → same ids, and the decoded
    // styles are indistinguishable from before the reset.
    expect(pool.intern(RED_FG)).toBe(redId)
    expect(pool.intern(BLUE_BOLD)).toBe(boldId)
    expect(pool.get(redId).map(c => c.code)).toEqual(baselineRed)
    expect(pool.get(boldId).map(c => c.code)).toEqual(baselineBold)
    expect(pool.transition(pool.none, redId)).toBe(baselineTransition)
    expect(pool.get(pool.withInverse(redId)).map(c => c.code)).toEqual(
      baselineInverse,
    )

    // Invariant: 'no style' must remain id 0 in every epoch — unwritten and
    // zeroed cells carry styleId 0.
    expect(pool.none).toBe(0)
  })

  test('epoch increments and size drops to the working set', () => {
    const pool = new StylePool()
    const screen = createScreen(4, 1, pool, new CharPool(), new HyperlinkPool())
    const before = pool.epoch

    for (let i = 0; i < 64; i++) {
      pool.intern([
        { type: 'ansi', code: `\x1b[38;5;${i}m`, endCode: '\x1b[39m' },
      ])
    }
    pool.reset(screen)

    expect(pool.epoch).toBe(before + 1)
    expect(pool.size).toBeLessThan(4)
  })

  test('overlay caches (inverse/current-match/selection-bg) are rebuilt consistently', () => {
    const pool = new StylePool()
    const screen = createScreen(2, 1, pool, new CharPool(), new HyperlinkPool())

    const baseId = pool.intern(RED_FG)
    // Paint the base style so it is alive in the buffer: reset() re-interns
    // exactly the styles present on the screen (see reset() docstring) — an
    // interned-but-never-painted style is dead by contract, and overlay
    // composites recomputed from a dead base would lose the base codes.
    setCellAt(screen, 0, 0, {
      char: 'x',
      styleId: baseId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })

    const invertedPre = codesToString(pool.get(pool.withInverse(baseId)))
    const currentMatchPre = codesToString(
      pool.get(pool.withCurrentMatch(baseId)),
    )
    const selectionBgPre = codesToString(pool.get(pool.withSelectionBg(baseId)))

    pool.reset(screen)

    const invertedPost = codesToString(pool.get(pool.withInverse(baseId)))
    const currentMatchPost = codesToString(
      pool.get(pool.withCurrentMatch(baseId)),
    )
    const selectionBgPost = codesToString(
      pool.get(pool.withSelectionBg(baseId)),
    )
    expect(invertedPost).toBe(invertedPre)
    expect(currentMatchPost).toBe(currentMatchPre)
    expect(selectionBgPost).toBe(selectionBgPre)
    // GREY_BG has a background → odd id (visible on space) in both epochs.
    const bgId = pool.intern(GREY_BG)
    expect(bgId % 2).toBe(1)
  })
})

describe('cross-epoch double-buffer diff', () => {
  test('remapped prev buffer vs fresh epoch paint: byte-identical frames, zero diff', () => {
    const pool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const log = new LogUpdate({ isTTY: false, stylePool: pool })

    // Epoch 0: paint the prev buffer (double-buffer front frame).
    const prevScreen = paintContent(pool, charPool, hyperlinkPool)
    const baseline = renderFrameToString(log, pool, prevScreen)
    expect(baseline).toContain('err')
    // SGR sequences survive serialization (styled runs emitted verbatim).
    expect(baseline).toContain('\x1b[31m')

    // Generation boundary: reset in place, remapping prevScreen's packed ids.
    pool.reset(prevScreen)

    // Byte-level invariant: the remapped buffer renders EXACTLY the same
    // bytes as before the reset (same content, new id index space).
    expect(renderFrameToString(log, pool, prevScreen)).toBe(baseline)

    // Double-buffer next turn: a fresh screen painted with identical content
    // post-reset. Same bytes…
    const nextScreen = paintContent(pool, charPool, hyperlinkPool)
    expect(renderFrameToString(log, pool, nextScreen)).toBe(baseline)

    // …and the diff between the remapped prev buffer and the fresh epoch
    // next buffer reports ZERO changes — no false positives, no repaint.
    expect(diff(prevScreen, nextScreen)).toEqual([])
  })

  test('cell payloads (char, width, hyperlink, spacer, style) survive the remap', () => {
    const pool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const screen = paintContent(pool, charPool, hyperlinkPool)

    const snapshot = (s: Screen) => {
      const wide = cellAt(s, 0, 1)
      const spacer = cellAt(s, 1, 1)
      const link = cellAt(s, 3, 1)
      const untouched = cellAt(s, 9, 3)
      return {
        wideChar: wide?.char,
        wideWidth: wide?.width,
        wideStyleCodes: codesToString(pool.get(wide?.styleId ?? 0)),
        spacerWidth: spacer?.width,
        link: link?.hyperlink,
        linkChar: link?.char,
        untouchedChar: untouched?.char,
        untouchedStyle: untouched?.styleId,
      }
    }
    const before = snapshot(screen)

    pool.reset(screen)

    // Cells keep char/width/hyperlink; styles decode to the same codes
    // through the new epoch's id space. Content SURVIVES the remap (the
    // loop only repacks word1 when the id changes).
    expect(snapshot(screen)).toEqual(before)
    // The untouched cell was never written: styleId 0 in both epochs.
    expect(before.untouchedStyle).toBe(0)

    // Style transition across a second epoch on a styled + hyperlinked cell.
    setCellAt(screen, 3, 1, {
      char: 'i',
      styleId: pool.intern(BLUE_BOLD),
      width: CellWidth.Narrow,
      hyperlink: 'https://example.com',
    })
    pool.reset(screen)
    const after = cellAt(screen, 3, 1)
    expect(after?.hyperlink).toBe('https://example.com')
    expect(codesToString(pool.get(after?.styleId ?? 0))).toBe(
      codesToString(BLUE_BOLD),
    )
  })

  test('control: a real style change IS detected across the epoch boundary', () => {
    const pool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()

    const prevScreen = paintContent(pool, charPool, hyperlinkPool)
    pool.reset(prevScreen)
    const nextScreen = paintContent(pool, charPool, hyperlinkPool)

    // Mutate one cell's style in the next buffer — the diff MUST report it,
    // proving the zero-diff result above is a real equality, not a vacuous
    // one (raw-int comparison still works post-remap).
    setCellAt(nextScreen, 0, 0, {
      char: 'e',
      styleId: pool.intern(BLUE_BOLD),
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })
    const changes = diff(prevScreen, nextScreen)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]![1]?.styleId).not.toBe(changes[0]![2]?.styleId)
  })

  test('Output charCache is invalidated on epoch change (no stale styleIds painted)', () => {
    const pool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const warm = createScreen(WIDTH, HEIGHT, pool, charPool, hyperlinkPool)
    const next = createScreen(WIDTH, HEIGHT, pool, charPool, hyperlinkPool)

    // Warm the charCache with a styled line in epoch 0.
    const out = new Output({
      width: WIDTH,
      height: HEIGHT,
      stylePool: pool,
      screen: warm,
    })
    out.write(0, 0, 'cached \x1b[31mred\x1b[39m text')
    out.get()

    // Generational rebuild, then reuse the SAME Output for the next frame.
    pool.reset(warm)
    out.reset(WIDTH, HEIGHT, next)
    out.write(0, 0, 'cached \x1b[31mred\x1b[39m text')
    out.get()

    // The red run in the fresh buffer must decode back to red via the new
    // epoch's pool. Without the charCache invalidation, the cached
    // ClusteredChar would carry the dead epoch's styleId and decode to a
    // different (or empty) style.
    const cells = next.cells
    // Locate the 'r' of "red": "cached " is 7 chars, so 'r' is at x=7.
    const word1 = cells[((0 * WIDTH + 7) << 1) + 1]!
    const styleId = word1 >>> 17 // STYLE_SHIFT
    expect(pool.get(styleId).map(c => c.code)).toEqual(RED_FG.map(c => c.code))
    expect(styleId).not.toBe(0)
  })
})

describe('STYLE_POOL_RESET_SIZE threshold', () => {
  test('threshold is 8192 and leaves headroom below the 15-bit packed capacity', () => {
    // word1 packs styleId (rawId << 1 | visibleBit) into bits [31:17]:
    // 15 bits → rawId capacity 16384. 8192 keeps margin for a full frame
    // worth of styles interned before the next rebuild.
    expect(STYLE_POOL_RESET_SIZE).toBe(8192)
    expect(STYLE_POOL_RESET_SIZE).toBeLessThan(16384)
  })

  test('interning past the threshold marks the pool over budget; reset() recovers it', () => {
    const pool = new StylePool()
    const screen = createScreen(2, 1, pool, new CharPool(), new HyperlinkPool())

    for (let i = 0; i < STYLE_POOL_RESET_SIZE + 100; i++) {
      pool.intern([
        { type: 'ansi', code: `\x1b[38;5;${i}m`, endCode: '\x1b[39m' },
      ])
    }
    expect(pool.size).toBeGreaterThan(STYLE_POOL_RESET_SIZE)

    pool.reset(screen)
    expect(pool.size).toBeLessThan(4)
    // Pool is fully functional after the rebuild: interning works and
    // transitions resolve to the right escape sequences.
    const bgId = pool.intern(GREY_BG)
    expect(pool.transition(pool.none, bgId)).toContain('\x1b[48;5;236m')
  })
})
