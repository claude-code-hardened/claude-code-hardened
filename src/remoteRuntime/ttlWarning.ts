/**
 * Self-hosted runner TTL awareness face — 80%-TTL token refresh schedule
 * warning (work package W8, task #59, block 3).
 *
 * Official anchor (decompiled), 0239-chunk-bxerm1mk/module-003-uncategorized.js:281
 * (self-hosted runner doctor runbook, §2 "Network" last row):
 *   "Mid-run `poll auth failed` on an otherwise-healthy runner |
 *    `date -u` vs `curl -sI <base>/ | grep -i '^date:'` |
 *    Runner clock skew throws off the 80%-TTL refresh schedule |
 *    Fix NTP on the host"
 * Related: runbook §9 row 3 — "`clock_skew_ms` ≥ 60000 (or ≤ −60000) ...
 *   Host clock drifted; hooks that verify the work-order JWT `exp` will
 *   mis-fire. Fix NTP on the host."
 *
 * Semantics (aligned with the official runbook): the "80%-TTL" point is
 * where the runner's token/work-order REFRESH is scheduled — a refresh
 * fired at 80% of the token TTL leaves headroom before the work-order JWT
 * `exp` at 100%. It is NOT a job-deadline countdown. When the host clock
 * drifts, the refresh lands at the wrong wall-clock position relative to
 * the server and mid-run poll auth fails — hence the runbook's decisive
 * fix "Fix NTP on the host".
 *
 * Pure function — no wall-clock reads, no I/O. The caller supplies the
 * token TTL and the time elapsed on the local clock since the last
 * successful token refresh so tests and the doctor entry can drive it
 * deterministically (see runnerDoctor.ts check `token_refresh_clock_skew`).
 */

/** Fraction of the token TTL at which the refresh-schedule warning fires. */
export const TTL_WARNING_THRESHOLD_RATIO = 0.8

/**
 * Compute the 80%-TTL token-refresh-schedule warning.
 *
 * @param ttlSec - Token / work-order TTL as a total duration in seconds.
 *   Non-finite or <= 0 disables the check.
 * @param sinceRefreshMs - Milliseconds elapsed on the LOCAL clock since
 *   the last successful token refresh. Negative values are degenerate
 *   (clock stepped backwards) and disable the check.
 * @returns Warning text once >= 80% of the TTL has elapsed since the last
 *   refresh (escalated wording past 100%, i.e. the refresh window was
 *   missed), or null below the threshold / for degenerate inputs.
 */
export function computeTokenRefreshTtlWarning(
  ttlSec: number,
  sinceRefreshMs: number,
): string | null {
  if (
    typeof ttlSec !== 'number' ||
    typeof sinceRefreshMs !== 'number' ||
    !Number.isFinite(ttlSec) ||
    !Number.isFinite(sinceRefreshMs) ||
    ttlSec <= 0 ||
    sinceRefreshMs < 0
  ) {
    return null
  }

  const totalMs = ttlSec * 1000
  if (sinceRefreshMs < TTL_WARNING_THRESHOLD_RATIO * totalMs) {
    return null
  }

  const pct = Math.min(100, Math.round((sinceRefreshMs / totalMs) * 100))
  if (sinceRefreshMs >= totalMs) {
    return (
      `[runner:ttl] 80%-TTL token refresh missed (100% of the ${ttlSec}s ` +
      'token TTL elapsed since the last refresh) — the scheduled refresh ' +
      'should have fired at the 80% point already; a mid-run poll auth ' +
      'failure here points at host clock offset, fix NTP on the host'
    )
  }
  const remainingMs = totalMs - sinceRefreshMs
  return (
    `[runner:ttl] token refresh due at the 80%-TTL point (${pct}% of the ` +
    `${ttlSec}s token TTL since the last refresh, ~${Math.round(remainingMs / 1000)}s ` +
    'of token left) — schedule/verify the refresh now; if poll auth starts ' +
    'failing mid-run, compare host clock (date -u) against the server Date ' +
    'header — clock skew throws off the 80%-TTL refresh schedule (runbook ' +
    '§2), fix NTP on the host'
  )
}
