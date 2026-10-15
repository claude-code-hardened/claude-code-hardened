/**
 * Tests for src/services/rateLimitGrace.ts — the official near-limit
 * wrap-up / grace-window state machine (workpackage 2.12).
 *
 * Official evidence: docs/reverse-284/full-source/_ALL.js — header parser
 * `PDn` (byte ~8640800), wrap-up machine `fve` (~8641933), manager Adt
 * near-limit hint (~8660400), note-injection generator `_co` (~13681xxx) and
 * the telemetry event family (usage_limit_grace_wrapup / _subagent /
 * _release / _release_subagent / usage_limit_near_wrapup).
 *
 * No mocks: rateLimitGrace.ts is pure logic (analytics queues without a
 * sink; bun:bundle's feature() returns false under bun test — which is
 * exactly the "flag off" case asserted below).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  GraceWrapUpState,
  NEAR_LIMIT_5H_UTILIZATION_THRESHOLD,
  USAGE_LIMIT_GRACE_WRAPUP_NOTE,
  USAGE_LIMIT_NEAR_WRAPUP_NOTE,
  USAGE_LIMIT_NEAR_WRAPUP_UI_NOTICE,
  buildMainTurnGraceNotes,
  buildSubagentGraceNote,
  consumePendingNearLimitWrapUpHint,
  continueAfterWrapUpAt,
  createGraceUiNotice,
  createUsageLimitNoteMessage,
  findLastUsageLimitNote,
  getGraceZone,
  getWrapUpSyntheticRejection,
  graceLeave,
  graceOnRefused,
  graceSubagentNoteDue,
  markGraceStartNotePlaced,
  observeGraceFromLimitsSnapshot,
  parseUnifiedGraceHeaders,
  resetGraceStateForTests,
  takeGraceTurnNote,
} from 'src/services/rateLimitGrace.js'

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000
const FUTURE_RESET_S = NOW_S + 60 * 60
const PAST_RESET_S = NOW_S - 60 * 60

function makeHeaders(record: Record<string, string>) {
  return new globalThis.Headers(record)
}

function observeFiveHour(
  utilization: number,
  resetsAt: number,
  extra: Record<string, unknown> = {},
) {
  observeGraceFromLimitsSnapshot(
    {
      status: 'allowed',
      fiveHour: { utilization, resetsAt },
      isUsingOverage: false,
      ...extra,
    },
    NOW_MS,
  )
}

beforeEach(() => {
  resetGraceStateForTests()
})

// ── Header parsing (pure function) ─────────────────────────────────────────

describe('parseUnifiedGraceHeaders', () => {
  test('skips when the unified status header is absent', () => {
    const parsed = parseUnifiedGraceHeaders(makeHeaders({}), NOW_MS)
    expect(parsed.limiterRan).toBe(false)
    expect(parsed.zone).toBeNull()
  })

  test('both utilizations zero → limiter ran but no zone', () => {
    const parsed = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0',
        'anthropic-ratelimit-unified-grace-7d-utilization': '0.0',
      }),
      NOW_MS,
    )
    expect(parsed.limiterRan).toBe(true)
    expect(parsed.zone).toBeNull()
  })

  test('clamps utilizations into [0,1] and drops garbage values to 0', () => {
    const parsed = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '1.5',
        'anthropic-ratelimit-unified-grace-7d-utilization': '-0.2',
      }),
      NOW_MS,
    )
    expect(parsed.limiterRan).toBe(true)
    expect(parsed.fiveHourUtilization).toBe(1)
    expect(parsed.sevenDayUtilization).toBe(0)
    expect(parsed.zone?.rateLimitType).toBe('five_hour')
  })

  test('stale 5h reset is invalid (epoch seconds must be > now-1000ms)', () => {
    const staleByTwoSeconds = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.8',
        'anthropic-ratelimit-unified-5h-reset': String(NOW_S - 2),
      }),
      NOW_MS,
    )
    expect(staleByTwoSeconds.zone?.rateLimitType).toBe('five_hour')
    expect(staleByTwoSeconds.zone?.resetsAt).toBeUndefined()

    // Within the 1000ms tolerance the reset still counts as valid.
    const withinTolerance = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.8',
        'anthropic-ratelimit-unified-5h-reset': String(NOW_S - 0.5),
      }),
      NOW_MS,
    )
    expect(withinTolerance.zone?.resetsAt).toBe(NOW_S - 0.5)
  })

  test('zone selection: 7d>0 and 5h invalid → seven_day', () => {
    const parsed = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-grace-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-7d-reset': String(FUTURE_RESET_S),
      }),
      NOW_MS,
    )
    expect(parsed.zone?.rateLimitType).toBe('seven_day')
    expect(parsed.zone?.resetsAt).toBe(FUTURE_RESET_S)
  })

  test('zone selection: 7d>0 but 5h valid and resets later → five_hour', () => {
    const parsed = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-grace-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-5h-reset': String(FUTURE_RESET_S + 600),
        'anthropic-ratelimit-unified-7d-reset': String(FUTURE_RESET_S),
      }),
      NOW_MS,
    )
    expect(parsed.zone?.rateLimitType).toBe('five_hour')
    expect(parsed.zone?.resetsAt).toBe(FUTURE_RESET_S + 600)
  })

  test('zone selection: 7d=0 → five_hour', () => {
    const parsed = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-grace-7d-utilization': '0',
        'anthropic-ratelimit-unified-5h-reset': String(FUTURE_RESET_S),
      }),
      NOW_MS,
    )
    expect(parsed.zone?.rateLimitType).toBe('five_hour')
  })

  test('covered: overage-status allowed / allowed_warning', () => {
    for (const status of ['allowed', 'allowed_warning'] as const) {
      const parsed = parseUnifiedGraceHeaders(
        makeHeaders({
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-grace-5h-utilization': '0.9',
          'anthropic-ratelimit-unified-5h-reset': String(FUTURE_RESET_S),
          'anthropic-ratelimit-unified-overage-status': status,
        }),
        NOW_MS,
      )
      expect(parsed.covered).toBe(true)
      expect(parsed.zone?.extraUsageStatus).toBe(status)
    }
  })

  test('covered: overage-in-use "true"; rejected overage status is not covered', () => {
    const inUse = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-5h-reset': String(FUTURE_RESET_S),
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      }),
      NOW_MS,
    )
    expect(inUse.covered).toBe(true)

    const rejectedOverage = parseUnifiedGraceHeaders(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-5h-reset': String(FUTURE_RESET_S),
        'anthropic-ratelimit-unified-overage-status': 'rejected',
      }),
      NOW_MS,
    )
    expect(rejectedOverage.covered).toBe(false)
  })
})

// ── State machine: full turn-note migration ────────────────────────────────

describe('GraceWrapUpState', () => {
  test('zone observation drives turnNote none → owed → taken → placed', () => {
    const state = new GraceWrapUpState()
    state.applyResponse(
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-5h-reset': String(FUTURE_RESET_S),
      }),
      NOW_MS,
    )
    expect(state.zone?.rateLimitType).toBe('five_hour')
    expect(state.covered).toBe(false)
    expect(state.turnNote).toBe('owed')

    expect(state.takeTurnNote(NOW_MS)).toBe(true)
    expect(state.turnNote).toBe('taken')
    expect(state.takeTurnNote(NOW_MS)).toBe(false)

    state.markStartNotePlaced()
    expect(state.turnNote).toBe('placed')
  })

  test('took note only succeeds once per grace window', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    markGraceStartNotePlaced()
    expect(graceSubagentNoteDue(NOW_MS)).toBe(true)
    expect(takeGraceTurnNote(NOW_MS)).toBe(false)
  })

  test('covered zone clears turnNote and onRefused resets coverage', () => {
    observeFiveHour(0.9, FUTURE_RESET_S, {
      overageStatus: 'allowed',
    })
    expect(getGraceZone(NOW_MS)?.extraUsageStatus).toBe('allowed')
    // covered → no note owed
    expect(takeGraceTurnNote(NOW_MS)).toBe(false)

    // A real refusal clears extraUsageStatus + covered, keeps the zone.
    graceOnRefused()
    expect(getGraceZone(NOW_MS)?.extraUsageStatus).toBeUndefined()
    expect(graceSubagentNoteDue(NOW_MS)).toBe(true)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
  })

  test('zone clear (both-zero observation) resets the note state', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    observeGraceFromLimitsSnapshot(
      { status: 'allowed', isUsingOverage: false },
      NOW_MS + 1,
    )
    expect(getGraceZone(NOW_MS + 1)).toBeNull()
    expect(takeGraceTurnNote(NOW_MS + 1)).toBe(false)
  })

  test('getZone lazily expires once the reset has passed', () => {
    observeFiveHour(0.9, NOW_S + 60)
    expect(getGraceZone(NOW_MS + 59_000)).not.toBeNull()
    expect(getGraceZone(NOW_MS + 60_000)).toBeNull()
  })

  test('onMainTurnStart without a prior note re-arms but take fails', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    observeGraceFromLimitsSnapshot(
      {
        status: 'allowed',
        fiveHour: { utilization: 0.95, resetsAt: FUTURE_RESET_S },
        isUsingOverage: false,
      },
      NOW_MS + 1,
    )
    // New zone while already taken → stays taken (official: only 'none'
    // transitions to 'owed').
    expect(takeGraceTurnNote(NOW_MS + 1)).toBe(false)
  })

  test('leave() clears everything and raises the fence', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    graceLeave(NOW_MS + 10)
    expect(getGraceZone(NOW_MS + 20)).toBeNull()
    // Out-of-order observation at an older timestamp is discarded.
    // (observeFiveHour always feeds NOW_MS, which is now below the fence.)
    observeFiveHour(0.9, FUTURE_RESET_S + 60)
    expect(getGraceZone(NOW_MS + 20)).toBeNull()
  })
})

// ── fenceMs out-of-order observations ─────────────────────────────────────

describe('fenceMs ordering', () => {
  test('applyResponse with a timestamp older than the fence is discarded', () => {
    const state = new GraceWrapUpState()
    const headers = () =>
      makeHeaders({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-grace-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-5h-reset': String(FUTURE_RESET_S),
      })
    state.applyResponse(headers(), NOW_MS + 2000)
    expect(state.zone).not.toBeNull()
    // Older observation arrives late — must not clobber state nor the fence.
    state.applyResponse(headers(), NOW_MS + 1000)
    expect(state.zone).not.toBeNull()
    expect(state.fenceMs).toBe(NOW_MS + 2000)
    // And a newer observation still applies.
    state.onRefused()
    state.applyResponse(headers(), NOW_MS + 3000)
    expect(state.fenceMs).toBe(NOW_MS + 3000)
  })

  test('observation snapshot feed respects the fence too', () => {
    observeGraceFromLimitsSnapshot(
      {
        status: 'allowed',
        fiveHour: { utilization: 0.8, resetsAt: FUTURE_RESET_S },
        isUsingOverage: false,
      },
      NOW_MS + 5000,
    )
    expect(getGraceZone(NOW_MS + 5000)).not.toBeNull()
    observeGraceFromLimitsSnapshot(
      { status: 'allowed', isUsingOverage: false },
      NOW_MS + 1000,
    )
    // Stale observation discarded → zone survives.
    expect(getGraceZone(NOW_MS + 5000)).not.toBeNull()
  })
})

// ── Synthetic rejection passthrough ────────────────────────────────────────

describe('continueAfterWrapUpAt / synthetic rejection', () => {
  test('placed + zone alive + uncovered → synthetic rejection', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    markGraceStartNotePlaced()

    expect(continueAfterWrapUpAt(NOW_MS)).toEqual({
      resetsAt: FUTURE_RESET_S,
      rateLimitType: 'five_hour',
    })
    expect(getWrapUpSyntheticRejection(NOW_MS)).toEqual({
      status: 'rejected',
      resetsAt: FUTURE_RESET_S,
      rateLimitType: 'five_hour',
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
      rateLimitGraceActive: true,
    })
  })

  test('no note taken → null (hard rejection stays a hard rejection)', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    expect(continueAfterWrapUpAt(NOW_MS)).toBeNull()
    expect(getWrapUpSyntheticRejection(NOW_MS)).toBeNull()
  })

  test('expired zone → null', () => {
    observeFiveHour(0.9, NOW_S + 30)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    markGraceStartNotePlaced()
    expect(continueAfterWrapUpAt(NOW_MS + 31_000)).toBeNull()
    expect(getWrapUpSyntheticRejection(NOW_MS + 31_000)).toBeNull()
  })

  test('covered zone (extra usage kicks in) → null', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    markGraceStartNotePlaced()
    observeGraceFromLimitsSnapshot(
      {
        status: 'allowed',
        fiveHour: { utilization: 1, resetsAt: FUTURE_RESET_S },
        isUsingOverage: true,
      },
      NOW_MS + 1,
    )
    expect(getWrapUpSyntheticRejection(NOW_MS + 1)).toBeNull()
  })
})

// ── Injection copy (character-for-character) ───────────────────────────────

describe('injection copy', () => {
  test('wrap-up note matches the official text', () => {
    expect(USAGE_LIMIT_GRACE_WRAPUP_NOTE).toBe(
      '[Usage limit reached — grace window active. Wrap up: finish or checkpoint; don\'t start subagents or long work.]',
    )
  })

  test('near-limit note matches the official text', () => {
    expect(USAGE_LIMIT_NEAR_WRAPUP_NOTE).toBe(
      '[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work. Don\'t start subagents or long-running work.]',
    )
  })

  test('UI notice matches the official text', () => {
    expect(USAGE_LIMIT_NEAR_WRAPUP_UI_NOTICE).toBe(
      'Approaching your 5-hour usage limit — Claude will wrap up the current step.',
    )
    const notice = createGraceUiNotice(NOW_MS)
    expect(notice.type).toBe('system')
    expect(notice.subtype).toBe('informational')
    expect(notice.level).toBe('notice')
    expect(notice.content).toBe(USAGE_LIMIT_NEAR_WRAPUP_UI_NOTICE)
    expect(notice.isMeta).toBe(false)
  })

  test('note message carries isMeta + turnCompanion + usageLimitNote', () => {
    const note = createUsageLimitNoteMessage({
      kind: 'wrap_up',
      now: NOW_MS,
    })
    expect(note.type).toBe('user')
    expect(note.isMeta).toBe(true)
    expect(note.turnCompanion).toBe(true)
    expect(note.usageLimitNote).toBe('wrap_up')
    expect(note.message.content).toBe(USAGE_LIMIT_GRACE_WRAPUP_NOTE)
    expect(note.timestamp).toBe(new Date(NOW_MS).toISOString())
    expect(note.uuid).toBeTruthy()
  })
})

// ── Retrospective dedup (official u() walk) ────────────────────────────────

describe('findLastUsageLimitNote', () => {
  test('walks backward and skips non-user messages', () => {
    const wrap = createUsageLimitNoteMessage({ kind: 'wrap_up', now: NOW_MS })
    const near = createUsageLimitNoteMessage({ kind: 'near_limit', now: NOW_MS })
    const messages = [
      wrap,
      { type: 'assistant' },
      { type: 'user' }, // plain user message without a note
      near,
      { type: 'system', subtype: 'informational' },
    ]
    expect(findLastUsageLimitNote(messages)).toBe('near_limit')
    expect(findLastUsageLimitNote([])).toBeUndefined()
    expect(findLastUsageLimitNote([{ type: 'user' }])).toBeUndefined()
  })
})

// ── Main-turn injection builder ────────────────────────────────────────────

describe('buildMainTurnGraceNotes', () => {
  test('no grace state → zero notes, zero notices', () => {
    const { notes, notices } = buildMainTurnGraceNotes({
      messages: [],
      isNewDepth0Question: true,
      now: NOW_MS,
    })
    expect(notes).toHaveLength(0)
    expect(notices).toHaveLength(0)
  })

  test('owed zone → exactly one wrap-up note, marked placed', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    const { notes, notices } = buildMainTurnGraceNotes({
      messages: [],
      isNewDepth0Question: true,
      now: NOW_MS,
    })
    expect(notes).toHaveLength(1)
    expect(notes[0]!.usageLimitNote).toBe('wrap_up')
    expect(notes[0]!.isMeta).toBe(true)
    expect(notes[0]!.message.content).toBe(USAGE_LIMIT_GRACE_WRAPUP_NOTE)
    expect(notices).toHaveLength(0)
    // Placed: the next turn does not inject again in the same window.
    const second = buildMainTurnGraceNotes({
      messages: [],
      isNewDepth0Question: true,
      now: NOW_MS + 1,
    })
    expect(second.notes).toHaveLength(0)
  })

  test('existing wrap-up note in history suppresses re-injection paths', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    const prior = createUsageLimitNoteMessage({
      kind: 'wrap_up',
      now: NOW_MS - 1,
    })
    const { notes } = buildMainTurnGraceNotes({
      messages: [prior],
      isNewDepth0Question: true,
      now: NOW_MS,
    })
    expect(notes).toHaveLength(0)
  })

  test('near-limit hint: UI notice + near_limit note when wrap-up is inert', () => {
    observeFiveHour(0.75, FUTURE_RESET_S)
    expect(NEAR_LIMIT_5H_UTILIZATION_THRESHOLD).toBe(0.7)
    expect(takeGraceTurnNote(NOW_MS)).toBe(true)
    markGraceStartNotePlaced()
    // A second high-utilization observation with the note already placed:
    // the window latch stays pending (once per window, key = resetsAt).
    observeFiveHour(0.8, FUTURE_RESET_S)
    const { notes, notices } = buildMainTurnGraceNotes({
      messages: [],
      isNewDepth0Question: true,
      now: NOW_MS + 1,
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toBe(USAGE_LIMIT_NEAR_WRAPUP_UI_NOTICE)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.usageLimitNote).toBe('near_limit')
    expect(notes[0]!.message.content).toBe(USAGE_LIMIT_NEAR_WRAPUP_NOTE)
    // Hint is once per window — a further build injects nothing.
    const again = buildMainTurnGraceNotes({
      messages: [],
      isNewDepth0Question: true,
      now: NOW_MS + 2,
    })
    expect(again.notes).toHaveLength(0)
    expect(again.notices).toHaveLength(0)
  })

  test('near-limit latch skips below-threshold / covered observations', () => {
    observeFiveHour(NEAR_LIMIT_5H_UTILIZATION_THRESHOLD - 0.01, FUTURE_RESET_S)
    expect(consumePendingNearLimitWrapUpHint(NOW_MS)).toBe(false)
    observeFiveHour(0.9, FUTURE_RESET_S, { overageStatus: 'allowed' })
    expect(consumePendingNearLimitWrapUpHint(NOW_MS)).toBe(false)
  })

  test('covered suppression of the wrap-up note', () => {
    observeFiveHour(0.9, FUTURE_RESET_S, { isUsingOverage: true })
    const { notes, notices } = buildMainTurnGraceNotes({
      messages: [],
      isNewDepth0Question: true,
      now: NOW_MS,
    })
    expect(notes).toHaveLength(0)
    expect(notices).toHaveLength(0)
  })

  test('flag off: subagent builder injects nothing', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    const note = buildSubagentGraceNote({
      messages: [],
      isSubagentDispatch: true,
      now: NOW_MS,
    })
    expect(note).toBeNull()
  })

  test('subagent dispatch guard requires agent sources', () => {
    observeFiveHour(0.9, FUTURE_RESET_S)
    const note = buildSubagentGraceNote({
      messages: [],
      isSubagentDispatch: false,
      now: NOW_MS,
    })
    expect(note).toBeNull()
  })
})
