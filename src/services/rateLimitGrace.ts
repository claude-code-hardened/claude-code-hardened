import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { feature } from 'bun:bundle'
import type { UserMessage } from '@ant/model-provider'
import { logEvent } from './analytics/index.js'
import type { ClaudeAILimits } from './claudeAiLimits.js'

/**
 * Official near-limit wrap-up / grace window state machine (workpackage 2.12).
 *
 * Reverse-engineered from the official 2.1.284 source (see
 * docs/reverse-284/full-source/_ALL.js): header parser `PDn`, wrap-up machine
 * `fve`, manager `Adt` (near-limit hint) and the note-injection generator
 * `_co`. Everything in this file is pure logic — the same module-level
 * singleton is shared by sessions and subagents, exactly like the official
 * single-instance `Td`.
 *
 * Order of the turn for the main loop (wired in QueryEngine.ts):
 *   1. feed observations  → observeGraceFromLimitsSnapshot() / installGraceLimitsListener()
 *   2. turn start         → buildMainTurnGraceNotes() (onMainTurnStart →
 *                            takeTurnNote → inject → markStartNotePlaced)
 *   3. refusal            → errors.ts 429 branch calls graceOnRefused() and
 *                            consumes getWrapUpSyntheticRejection() with
 *                            unifiedRateLimitFallbackAvailable:false.
 */

// ── Header names (official constants) ──────────────────────────────────────

const UNIFIED_STATUS_HEADER = 'anthropic-ratelimit-unified-status'
const GRACE_5H_UTILIZATION_HEADER =
  'anthropic-ratelimit-unified-grace-5h-utilization'
const GRACE_7D_UTILIZATION_HEADER =
  'anthropic-ratelimit-unified-grace-7d-utilization'
const FIVE_HOUR_RESET_HEADER = 'anthropic-ratelimit-unified-5h-reset'
const SEVEN_DAY_RESET_HEADER = 'anthropic-ratelimit-unified-7d-reset'
const OVERAGE_STATUS_HEADER = 'anthropic-ratelimit-unified-overage-status'
const OVERAGE_IN_USE_HEADER = 'anthropic-ratelimit-unified-overage-in-use'

/**
 * A reset header is only valid when it is (barely) in the future: epoch
 * seconds multiplied by 1000 must exceed now-1000ms.
 */
const RESET_VALIDITY_TOLERANCE_MS = 1000

/**
 * Near-limit trigger: warn once per 5h window when utilization reaches this.
 * Spec-grace value (the official default gate threshold was higher;
 * see workpackage report).
 */
export const NEAR_LIMIT_5H_UTILIZATION_THRESHOLD = 0.7

// ── Injection copy (official strings, character-for-character) ─────────────

export const USAGE_LIMIT_GRACE_WRAPUP_NOTE =
  "[Usage limit reached — grace window active. Wrap up: finish or checkpoint; don't start subagents or long work.]"

export const USAGE_LIMIT_NEAR_WRAPUP_NOTE =
  "[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work. Don't start subagents or long-running work.]"

/**
 * UI notice shown alongside the near-limit note. System message level is the
 * official `notice`.
 */
export const USAGE_LIMIT_NEAR_WRAPUP_UI_NOTICE =
  'Approaching your 5-hour usage limit — Claude will wrap up the current step.'

/**
 * Release note text. The official default (no remote config) is empty, which
 * suppresses the release note entirely — kept for parity.
 */
export const USAGE_LIMIT_GRACE_RELEASE_NOTE = ''

// ── Types ──────────────────────────────────────────────────────────────────

export type GraceZoneType = 'five_hour' | 'seven_day'

export type GraceZone = {
  rateLimitType: GraceZoneType
  resetsAt?: number
  extraUsageStatus?: 'allowed' | 'allowed_warning'
}

export type GraceTurnNoteState = 'none' | 'owed' | 'taken' | 'placed'

export type GraceHeadersLike = { get(name: string): string | null }

export type ParsedGraceHeaders = {
  /** false when the unified-status header is absent — limiter did not run */
  limiterRan: boolean
  zone: GraceZone | null
  covered: boolean
  fiveHourUtilization: number
  sevenDayUtilization: number
  fiveHourReset?: number
  sevenDayReset?: number
}

export type UsageLimitNoteKind = 'wrap_up' | 'near_limit' | 'release'

/** Telemetry event names (official near-limit wrap-up family). */
export type GraceTelemetryEvent =
  | 'usage_limit_grace_wrapup'
  | 'usage_limit_grace_wrapup_subagent'
  | 'usage_limit_grace_release'
  | 'usage_limit_grace_release_subagent'
  | 'usage_limit_near_wrapup'

/** Readings lifted from claudeAiLimits (raw per-window utilization). */
export type GraceWindowObservation = { utilization: number; resetsAt: number }

export type GraceLimitsObservation = {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  fiveHour?: GraceWindowObservation
  sevenDay?: GraceWindowObservation
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected'
  isUsingOverage: boolean
}

/** Synthetic rejection shape (official dxt builder output). */
export type GraceSyntheticRejection = ClaudeAILimits & {
  rateLimitGraceActive: boolean
}

// ── Header parsing (official PDn) ──────────────────────────────────────────

function readClampedUtilization(
  headers: GraceHeadersLike,
  name: string,
): number {
  const value = Number(headers.get(name) ?? 0)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function readResetSeconds(
  headers: GraceHeadersLike,
  name: string,
  nowMs: number,
): number | undefined {
  const value = Number(headers.get(name) ?? Number.NaN)
  const isValid =
    Number.isFinite(value) && value * 1000 > nowMs - RESET_VALIDITY_TOLERANCE_MS
  return isValid ? Math.round(value) : undefined
}

function readExtraUsageStatus(
  headers: GraceHeadersLike,
): 'allowed' | 'allowed_warning' | undefined {
  const status = headers.get(OVERAGE_STATUS_HEADER)
  return status === 'allowed' || status === 'allowed_warning'
    ? status
    : undefined
}

/**
 * Parse the unified rate limiter headers into a grace observation.
 * - unified-status header absent → limiterRan:false (skip)
 * - both grace utilizations clamp to 0 → no zone
 * - zone selection: 7d utilization > 0 and not ("5h valid and resets later")
 *   → seven_day, otherwise five_hour
 */
export function parseUnifiedGraceHeaders(
  headers: GraceHeadersLike,
  nowMs: number,
): ParsedGraceHeaders {
  if (headers.get(UNIFIED_STATUS_HEADER) === null) {
    return {
      limiterRan: false,
      zone: null,
      covered: false,
      fiveHourUtilization: 0,
      sevenDayUtilization: 0,
    }
  }
  const fiveHourUtilization = readClampedUtilization(
    headers,
    GRACE_5H_UTILIZATION_HEADER,
  )
  const sevenDayUtilization = readClampedUtilization(
    headers,
    GRACE_7D_UTILIZATION_HEADER,
  )
  if (fiveHourUtilization === 0 && sevenDayUtilization === 0) {
    return {
      limiterRan: true,
      zone: null,
      covered: false,
      fiveHourUtilization: 0,
      sevenDayUtilization: 0,
    }
  }
  const fiveHourReset = readResetSeconds(headers, FIVE_HOUR_RESET_HEADER, nowMs)
  const sevenDayReset = readResetSeconds(headers, SEVEN_DAY_RESET_HEADER, nowMs)
  const extraUsageStatus = readExtraUsageStatus(headers)
  const fiveHourResetsLater =
    fiveHourUtilization > 0 &&
    fiveHourReset !== undefined &&
    (sevenDayReset === undefined || fiveHourReset > sevenDayReset)
  const rateLimitType: GraceZoneType =
    sevenDayUtilization > 0 && !fiveHourResetsLater ? 'seven_day' : 'five_hour'
  return {
    limiterRan: true,
    zone: {
      rateLimitType,
      resetsAt: rateLimitType === 'seven_day' ? sevenDayReset : fiveHourReset,
      ...(extraUsageStatus !== undefined && { extraUsageStatus }),
    },
    covered:
      extraUsageStatus !== undefined ||
      headers.get(OVERAGE_IN_USE_HEADER) === 'true',
    fiveHourUtilization,
    sevenDayUtilization,
    ...(fiveHourReset !== undefined && { fiveHourReset }),
    ...(sevenDayReset !== undefined && { sevenDayReset }),
  }
}

// ── Wrap-up state machine (official fve) ───────────────────────────────────

export class GraceWrapUpState {
  zone: GraceZone | null = null
  covered = false
  turnNote: GraceTurnNoteState = 'none'
  /** applyResponse calls with an older timestamp are discarded. */
  fenceMs = 0

  /** Lazily expired view: a zone whose reset has passed reads as null. */
  getZone(nowMs: number = Date.now()): GraceZone | null {
    const zone = this.zone
    if (
      zone !== null &&
      zone.resetsAt !== undefined &&
      nowMs / 1000 >= zone.resetsAt
    ) {
      return null
    }
    return zone
  }

  applyResponse(headers: GraceHeadersLike, nowMs: number): void {
    this.applyParsed(parseUnifiedGraceHeaders(headers, nowMs), nowMs)
  }

  applyParsed(parsed: ParsedGraceHeaders, nowMs: number): void {
    if (!parsed.limiterRan || nowMs < this.fenceMs) {
      return
    }
    this.fenceMs = nowMs
    if (parsed.zone === null || parsed.zone.resetsAt !== undefined) {
      this.dropEndedZone(nowMs)
    }
    this.zone = parsed.zone
    this.covered = parsed.zone !== null && parsed.covered
    if (parsed.zone === null || parsed.covered) {
      this.turnNote = 'none'
    } else if (this.turnNote === 'none') {
      this.turnNote = 'owed'
    }
  }

  dropEndedZone(nowMs: number): void {
    if (this.zone !== null && this.getZone(nowMs) === null) {
      this.zone = null
      this.covered = false
      this.turnNote = 'none'
    }
  }

  /** A real quota refusal clears the extra-usage coverage of the zone. */
  onRefused(): void {
    if (this.zone !== null && this.zone.extraUsageStatus !== undefined) {
      this.zone = { ...this.zone, extraUsageStatus: undefined }
    }
    this.covered = false
  }

  /** Full clear + fence raise (account switch / signed-out release path). */
  leave(nowMs: number = Date.now()): void {
    this.zone = null
    this.covered = false
    this.turnNote = 'none'
    this.fenceMs = Math.max(this.fenceMs, nowMs)
  }

  /** Official onMainTurnStart — every main-loop depth-0 turn entry. */
  onMainTurnStart(): void {
    this.turnNote = 'none'
  }

  /** owed → taken. Only succeeds once per grace window. */
  takeTurnNote(nowMs: number = Date.now()): boolean {
    this.dropEndedZone(nowMs)
    if (this.turnNote !== 'owed') {
      return false
    }
    this.turnNote = 'taken'
    return true
  }

  /** taken → placed, once the note is on its way into the transcript. */
  markStartNotePlaced(): void {
    if (this.turnNote === 'taken') {
      this.turnNote = 'placed'
    }
  }

  /**
   * The wrap-up note was placed and the zone is alive and not covered:
   * the API rejection that follows is expected — the turn stops here.
   */
  continueAfterWrapUpAt(
    nowMs: number = Date.now(),
  ): { resetsAt: number; rateLimitType: GraceZoneType } | null {
    const zone = this.getZone(nowMs)
    if (
      this.turnNote === 'placed' &&
      zone !== null &&
      !this.covered &&
      zone.resetsAt !== undefined
    ) {
      return { resetsAt: zone.resetsAt, rateLimitType: zone.rateLimitType }
    }
    return null
  }

  /** Zone alive and not covered — a note is due (main or subagent). */
  subagentNoteDue(nowMs: number = Date.now()): boolean {
    return this.getZone(nowMs) !== null && !this.covered
  }
}

/** Module-level singleton — shared across sessions and subagents. */
const grace = new GraceWrapUpState()

export function getGraceWrapUp(): GraceWrapUpState {
  return grace
}

// ── Near-limit hint (official Adt/pendingNearLimitWrapUpHint) ──────────────

let pendingNearLimitWrapUpHint = false
let nearLimitWrapUpWindowKey: number | null = null

function expireNearLimitWindow(nowMs: number): void {
  if (
    nearLimitWrapUpWindowKey !== null &&
    nowMs / 1000 > nearLimitWrapUpWindowKey
  ) {
    pendingNearLimitWrapUpHint = false
    nearLimitWrapUpWindowKey = null
  }
}

function updateNearLimitHint(parsed: ParsedGraceHeaders, nowMs: number): void {
  expireNearLimitWindow(nowMs)
  if (!parsed.limiterRan) {
    return
  }
  // A fresh future 5h reset is required to key the once-per-window latch.
  if (
    parsed.fiveHourReset === undefined ||
    parsed.fiveHourReset * 1000 <= nowMs
  ) {
    return
  }
  if (parsed.fiveHourUtilization < NEAR_LIMIT_5H_UTILIZATION_THRESHOLD) {
    return
  }
  // Covered by extra usage — no wrap-up needed for this window.
  if (grace.covered) {
    return
  }
  if (parsed.zone?.extraUsageStatus !== undefined) {
    pendingNearLimitWrapUpHint = false
    return
  }
  if (nearLimitWrapUpWindowKey !== parsed.fiveHourReset) {
    pendingNearLimitWrapUpHint = true
    nearLimitWrapUpWindowKey = parsed.fiveHourReset
  }
}

/** Consumes the pending near-limit hint (once per 5h window, not covered). */
export function consumePendingNearLimitWrapUpHint(
  nowMs: number = Date.now(),
): boolean {
  expireNearLimitWindow(nowMs)
  if (!pendingNearLimitWrapUpHint) {
    return false
  }
  pendingNearLimitWrapUpHint = false
  return !grace.covered
}

// ── Observation feed (adaptation: claudeAiLimits snapshot → pure parser) ───

/**
 * Adapter: apply a claudeAiLimits-style limits observation. The official code
 * feeds raw response headers into the machine on every API response; CCH keeps
 * rateLimitGrace free of the heavy claudeAiLimits import, so callers pass a
 * small snapshot instead (buildGraceLimitsObservation helpers).
 */
export function observeGraceFromLimitsSnapshot(
  observation: GraceLimitsObservation,
  nowMs: number = Date.now(),
): void {
  try {
    const headers = new globalThis.Headers()
    headers.set(UNIFIED_STATUS_HEADER, observation.status)
    if (observation.fiveHour) {
      headers.set(
        GRACE_5H_UTILIZATION_HEADER,
        String(observation.fiveHour.utilization),
      )
      headers.set(FIVE_HOUR_RESET_HEADER, String(observation.fiveHour.resetsAt))
    }
    if (observation.sevenDay) {
      headers.set(
        GRACE_7D_UTILIZATION_HEADER,
        String(observation.sevenDay.utilization),
      )
      headers.set(SEVEN_DAY_RESET_HEADER, String(observation.sevenDay.resetsAt))
    }
    if (
      observation.overageStatus === 'allowed' ||
      observation.overageStatus === 'allowed_warning'
    ) {
      headers.set(OVERAGE_STATUS_HEADER, observation.overageStatus)
    }
    if (observation.isUsingOverage) {
      headers.set(OVERAGE_IN_USE_HEADER, 'true')
    }
    const fenceBefore = grace.fenceMs
    const parsed = parseUnifiedGraceHeaders(headers, nowMs)
    grace.applyParsed(parsed, nowMs)
    // Stale (out-of-order) observations update nothing on the machine.
    if (nowMs >= fenceBefore) {
      updateNearLimitHint(parsed, nowMs)
    }
  } catch {
    // Grace observation must never break the turn.
  }
}

type GraceLimitsModule = typeof import('./claudeAiLimits.js')

function observationFromLimitsModule(
  mod: GraceLimitsModule,
): GraceLimitsObservation {
  const raw = mod.getRawUtilization()
  const fiveHour = raw.five_hour
  const sevenDay = raw.seven_day
  return {
    status: mod.currentLimits.status,
    ...(fiveHour && {
      fiveHour: {
        utilization: fiveHour.utilization,
        resetsAt: fiveHour.resets_at,
      },
    }),
    ...(sevenDay && {
      sevenDay: {
        utilization: sevenDay.utilization,
        resetsAt: sevenDay.resets_at,
      },
    }),
    overageStatus: mod.currentLimits.overageStatus,
    isUsingOverage: mod.currentLimits.isUsingOverage === true,
  }
}

let graceLimitsListenerInstalled = false

/**
 * Subscribe to claudeAiLimits status emissions so the module-level singleton
 * stays fresh between turns and inside subagents. Idempotent.
 */
export async function installGraceLimitsListener(): Promise<void> {
  if (graceLimitsListenerInstalled) {
    return
  }
  graceLimitsListenerInstalled = true
  try {
    const claudeAiLimits: GraceLimitsModule = await import(
      './claudeAiLimits.js'
    )
    claudeAiLimits.statusListeners.add(limits => {
      try {
        observeGraceFromLimitsSnapshot(
          observationFromLimitsModule({
            ...claudeAiLimits,
            currentLimits: limits,
          }),
          Date.now(),
        )
      } catch {
        // swallow — observations are best-effort
      }
    })
  } catch {
    // claudeAiLimits unavailable (tests) — snapshot feeding still works.
  }
}

// ── Refusal / synthetic rejection ──────────────────────────────────────────

export function graceOnRefused(): void {
  try {
    grace.onRefused()
  } catch {
    // never break the error path
  }
}

export function graceLeave(nowMs: number = Date.now()): void {
  grace.leave(nowMs)
  // Official leave/account-switch path also clears the near-limit latch
  // (pendingNearLimitWrapUpHint=!1; nearLimitWrapUpWindowKey=null) so a stale
  // hint cannot leak across accounts.
  pendingNearLimitWrapUpHint = false
  nearLimitWrapUpWindowKey = null
}

export function getGraceZone(nowMs: number = Date.now()): GraceZone | null {
  return grace.getZone(nowMs)
}

export function takeGraceTurnNote(nowMs: number = Date.now()): boolean {
  return grace.takeTurnNote(nowMs)
}

export function markGraceStartNotePlaced(): void {
  grace.markStartNotePlaced()
}

export function graceMainTurnStart(): void {
  grace.onMainTurnStart()
}

export function graceSubagentNoteDue(nowMs: number = Date.now()): boolean {
  return grace.subagentNoteDue(nowMs)
}

export function continueAfterWrapUpAt(nowMs: number = Date.now()) {
  return grace.continueAfterWrapUpAt(nowMs)
}

/**
 * Official dxt builder: the placed wrap-up note plus an alive, uncovered zone
 * turns the next API rejection into the synthetic end-of-turn rejection.
 * unifiedRateLimitFallbackAvailable is always false — the fallback-model path
 * must not be taken.
 */
export function getWrapUpSyntheticRejection(
  nowMs: number = Date.now(),
): GraceSyntheticRejection | null {
  const rejection = grace.continueAfterWrapUpAt(nowMs)
  if (rejection === null) {
    return null
  }
  return {
    status: 'rejected',
    resetsAt: rejection.resetsAt,
    rateLimitType: rejection.rateLimitType,
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
    rateLimitGraceActive: true,
  }
}

// ── Note messages (official Re/Ut builders) ────────────────────────────────

function isUsageLimitNoteKind(value: unknown): value is UsageLimitNoteKind {
  return value === 'wrap_up' || value === 'near_limit' || value === 'release'
}

function getDefaultNoteText(kind: UsageLimitNoteKind): string {
  switch (kind) {
    case 'wrap_up':
      return USAGE_LIMIT_GRACE_WRAPUP_NOTE
    case 'near_limit':
      return USAGE_LIMIT_NEAR_WRAPUP_NOTE
    case 'release':
      return USAGE_LIMIT_GRACE_RELEASE_NOTE
  }
}

/**
 * Meta user message carrying the wrap-up/near-limit/release note. Extra
 * fields follow the official message shape (isMeta + turnCompanion +
 * usageLimitNote on the message itself) so the retrospective dedup
 * (findLastUsageLimitNote) can walk backward over any transcript.
 */
export function createUsageLimitNoteMessage({
  kind,
  content,
  now,
  uuid,
}: {
  kind: UsageLimitNoteKind
  content?: string
  now?: number
  uuid?: string
}): UserMessage {
  const nowMs = now ?? Date.now()
  const note: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: content === undefined ? getDefaultNoteText(kind) : content,
    },
    isMeta: true,
    turnCompanion: true,
    usageLimitNote: kind,
    uuid: (uuid as UUID | undefined) ?? randomUUID(),
    timestamp: new Date(nowMs).toISOString(),
  }
  return note
}

/** UI notice (official Ut builder: system message at `notice` level). */
export function createGraceUiNotice(now: number = Date.now()): {
  type: 'system'
  subtype: 'informational'
  content: string
  level: string
  isMeta: false
  timestamp: string
  uuid: UUID
} {
  return {
    type: 'system',
    subtype: 'informational',
    content: USAGE_LIMIT_NEAR_WRAPUP_UI_NOTICE,
    level: 'notice',
    isMeta: false,
    timestamp: new Date(now).toISOString(),
    uuid: randomUUID(),
  }
}

/** Official u() — walk backward to the nearest usageLimitNote user message. */
export function findLastUsageLimitNote(
  messages: ReadonlyArray<unknown>,
): UsageLimitNoteKind | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as
      | { type?: string; usageLimitNote?: unknown }
      | null
      | undefined
    if (
      message !== null &&
      message !== undefined &&
      message.type === 'user' &&
      isUsageLimitNoteKind(message.usageLimitNote)
    ) {
      return message.usageLimitNote
    }
  }
  return undefined
}

// ── Telemetry (official event family) ──────────────────────────────────────

type GraceEventMetadata = { [key: string]: boolean | number | undefined }

function logGraceEvent(
  eventName: GraceTelemetryEvent,
  metadata: GraceEventMetadata = {},
): void {
  try {
    logEvent(eventName, metadata)
  } catch {
    // analytics unavailable (tests) — telemetry is best-effort
  }
}

// ── Injection builders (official _co, main loop + subagent split) ──────────

export type GraceTurnNote = {
  notes: UserMessage[]
  notices: ReturnType<typeof createGraceUiNotice>[]
}

/**
 * Main-loop turn-start injection. Run at each main-loop depth-0 new question
 * (QueryEngine.submitMessage): onMainTurnStart → takeTurnNote → inject the
 * wrap-up meta note → markStartNotePlaced, then the once-per-window
 * near-limit hint (UI notice + note, skipped when a wrap-up note was
 * already injected this turn) and the default-inert release detection.
 */
export function buildMainTurnGraceNotes({
  messages,
  isNewDepth0Question,
  observation,
  now = Date.now(),
}: {
  messages: ReadonlyArray<unknown>
  isNewDepth0Question: boolean
  observation?: GraceLimitsObservation
  now?: number
}): GraceTurnNote {
  const notes: GraceTurnNote['notes'] = []
  const notices: GraceTurnNote['notices'] = []
  try {
    if (observation) {
      observeGraceFromLimitsSnapshot(observation, now)
    }
    // Official: s = isMainLoop && depth === 0 && isNewQuestion(t)
    const due = isNewDepth0Question && grace.subagentNoteDue(now)
    if (isNewDepth0Question && !due) {
      grace.onMainTurnStart()
    }
    let taken = false
    if (isNewDepth0Question && due) {
      taken = grace.takeTurnNote(now)
      if (due && !taken) {
        const priorNote = findLastUsageLimitNote(messages)
        if (priorNote !== 'wrap_up' && priorNote !== 'near_limit') {
          grace.onMainTurnStart()
        }
      }
    }
    let wrappedUp = false
    if (taken) {
      notes.push(createUsageLimitNoteMessage({ kind: 'wrap_up', now }))
      logGraceEvent('usage_limit_grace_wrapup', {
        next_steps: false,
        custom: false,
      })
      grace.markStartNotePlaced()
      wrappedUp = true
    }
    // Release detection: a previous wrap-up/near-limit note and the zone is
    // no longer alive-without-extra-usage. Official default release text is
    // empty → no note is pushed (parity with the official defaults).
    if (isNewDepth0Question) {
      const zone = grace.getZone(now)
      const zoneAliveWithoutExtraUsage =
        zone !== null && zone.extraUsageStatus === undefined
      if (!zoneAliveWithoutExtraUsage) {
        const priorNote = findLastUsageLimitNote(messages)
        if (priorNote === 'wrap_up' || priorNote === 'near_limit') {
          const releaseText = getDefaultNoteText('release')
          if (releaseText !== '') {
            notes.push(
              createUsageLimitNoteMessage({
                kind: 'release',
                content: releaseText,
                now,
              }),
            )
            logGraceEvent('usage_limit_grace_release', {})
          }
        }
      }
    }
    // Near-limit: once per 5h window, not covered. Official evaluates this at
    // depth > 0 inside the query loop; QueryEngine-scope (query.ts is outside
    // this workpackage) evaluates it at the main-turn entry instead.
    if (isNewDepth0Question && consumePendingNearLimitWrapUpHint(now)) {
      notices.push(createGraceUiNotice(now))
      if (!wrappedUp) {
        notes.push(createUsageLimitNoteMessage({ kind: 'near_limit', now }))
      }
      logGraceEvent('usage_limit_near_wrapup', {})
    }
  } catch {
    // Grace injection must never break the turn.
  }
  return { notes, notices }
}

/**
 * Subagent dispatch injection (Task/Agent tool). Gated behind the
 * LANTERN_WICK_BRAID feature flag (register name mirrors the official
 * tengu_lantern_wick_braid gate); default off. Flag off ⇒ zero injection.
 */
export function buildSubagentGraceNote({
  messages,
  isSubagentDispatch,
  now = Date.now(),
}: {
  messages: ReadonlyArray<unknown>
  isSubagentDispatch: boolean
  now?: number
}): UserMessage | null {
  try {
    if (!feature('LANTERN_WICK_BRAID')) {
      return null
    }
    if (!isSubagentDispatch) {
      return null
    }
    if (!grace.subagentNoteDue(now)) {
      return null
    }
    if (findLastUsageLimitNote(messages) === 'wrap_up') {
      return null
    }
    const note = createUsageLimitNoteMessage({ kind: 'wrap_up', now })
    logGraceEvent('usage_limit_grace_wrapup_subagent', {
      next_steps: false,
      custom: false,
    })
    return note
  } catch {
    return null
  }
}

/** Test-only: reset the module singleton between test cases. */
export function resetGraceStateForTests(): void {
  grace.zone = null
  grace.covered = false
  grace.turnNote = 'none'
  grace.fenceMs = 0
  pendingNearLimitWrapUpHint = false
  nearLimitWrapUpWindowKey = null
}
