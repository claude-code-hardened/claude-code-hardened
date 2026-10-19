/**
 * selfHostedRunnerDoctorMain — self-hosted runner doctor entry
 * (work package W8, task #59, block 2).
 *
 * Official anchor (decompiled):
 *   - 0239-chunk-bxerm1mk/module-003-uncategorized.js:227 —
 *     `export{z as selfHostedRunnerDoctorMain}` — the official
 *     `claude self-hosted-runner doctor` entry. In the official build it
 *     spawns an interactive wizard session over `self_hosted_runner_*`
 *     read tools (§0 "typed read tools ... /healthz, /metrics, redacted
 *     log tail") across the runbook's 9 diagnostic categories.
 *   - Same file:389-397 — the wizard prompt ("pick from the 8 diagnostic
 *     categories") and the official help text; the runbook body numbers
 *     NINE category sections (8 = "Webhook", design-stage, so the wizard
 *     prompt says 8).
 *   - src/screens/Doctor.tsx supplies the local interactive Doctor
 *     structure: a checklist of typed diagnostics, each rendered with a
 *     status. This entry mirrors that *structure* (category + name +
 *     status + detail per row) but stays an independent, non-Ink entry —
 *     the runner host has no REPL.
 *
 * CCH scope (NOT the official 9-category wizard): a dependency / config /
 * env checklist with structured output:
 *   - dependency — kubectl / docker (runbook "operator laptop" evidence
 *     path) and git (runbook §4 "git clone failed: authentication" /
 *     "command not found" session-execution preconditions)
 *   - config — health port parseability (runbook §7), 80%-TTL token
 *     refresh clock-skew check via computeTokenRefreshTtlWarning (block 3)
 *   - env — runner identity/auth faces (CLAUDE_CODE_ENVIRONMENT_
 *     RUNNER_VERSION header, session ingress token file/FD, base dir)
 *
 * TODO(coverage): runbook categories with NO CCH check yet —
 *   §1 auth chain (only the env *source* is probed, not the 4-token
 *      refresh chain), §2 network (DNS/TLS/proxy/429 rows unprobed),
 *   §3 runner lifecycle, §4 session execution, §5 queue/placement,
 *   §6 version/compatibility, §7 observability gaps (log-file/metrics
 *      scraping), §8 webhook, §9 orchestrator/autoscaling.
 *
 * Exit code: 0 when no check failed, 1 when any check failed (warnings
 * do not fail the doctor). `--json` prints the machine-readable form.
 */

import { access, constants } from 'fs/promises'
import { computeTokenRefreshTtlWarning } from './ttlWarning.js'
import { resolveRunnerHealthPort } from './healthServer.js'

export type RunnerDoctorCategory = 'dependency' | 'config' | 'env'

export type RunnerDoctorStatus = 'ok' | 'warn' | 'fail'

export type RunnerDoctorCheck = {
  name: string
  category: RunnerDoctorCategory
  status: RunnerDoctorStatus
  detail: string
}

export type RunnerDoctorResult = {
  checks: RunnerDoctorCheck[]
  failed: number
  warned: number
  ok: boolean
}

export type RunnerDoctorProbe = {
  /** Resolves a binary on PATH, mirroring `which <tool>` (runbook §4). */
  which: (bin: string) => string | undefined
  /** Whether a path exists / is readable (secret file, base dir). */
  pathReadable: (path: string) => Promise<boolean>
}

const DEFAULT_PROBE: RunnerDoctorProbe = {
  which: (bin: string) => {
    // Bun.which is synchronous and needs no process spawn.
    return Bun.which(bin) || undefined
  },
  pathReadable: async (path: string) => {
    try {
      await access(path, constants.R_OK)
      return true
    } catch {
      return false
    }
  },
}

const RUNNER_DEPENDENCY_BINS = ['kubectl', 'docker'] as const

/**
 * Dependency checks — evidence-gathering tools from the runbook. kubectl
 * / docker missing only limits what the doctor/operator can inspect (warn);
 * git is a hard session-execution precondition (runbook §4) and missing
 * git fails the check.
 */
export function evaluateRunnerDependencyChecks(
  probe: RunnerDoctorProbe,
): RunnerDoctorCheck[] {
  const checks: RunnerDoctorCheck[] = []
  for (const bin of RUNNER_DEPENDENCY_BINS) {
    const path = probe.which(bin)
    checks.push({
      name: `dependency_${bin}`,
      category: 'dependency',
      status: path ? 'ok' : 'warn',
      detail: path
        ? `${bin} available at ${path}`
        : `${bin} not on PATH — kubectl/docker log evidence unavailable from this host`,
    })
  }
  const gitPath = probe.which('git')
  checks.push({
    name: 'dependency_git',
    category: 'dependency',
    status: gitPath ? 'ok' : 'fail',
    detail: gitPath
      ? `git available at ${gitPath}`
      : 'git not on PATH — child sessions will fail with "git clone failed: authentication"/"command not found" class errors (runbook §4)',
  })
  return checks
}

/**
 * CCH-custom env faces for the token refresh TTL check. These names have
 * NO official env surface counterpart — the official runner learns its
 * refresh schedule from the orchestrator work-order, not from env vars —
 * so they are explicitly prefixed `CCH_RUNNER_` and must not be presented
 * as official configuration:
 *   CCH_RUNNER_TOKEN_TTL_SEC  — token/work-order TTL, total seconds
 *   CCH_RUNNER_TOKEN_AGE_MS   — local-clock ms since the last refresh
 */
export const RUNNER_TOKEN_TTL_SEC_ENV = 'CCH_RUNNER_TOKEN_TTL_SEC'
export const RUNNER_TOKEN_AGE_MS_ENV = 'CCH_RUNNER_TOKEN_AGE_MS'

/**
 * Config checks — pure (env passthrough): health port parseability and
 * the 80%-TTL token refresh clock-skew check (runbook §2 last row /
 * §9 row 3).
 *   SELF_HOSTED_RUNNER_HEALTH_PORT   — /healthz port (0 = disabled)
 *   CCH_RUNNER_TOKEN_TTL_SEC         — CCH-custom; see above
 *   CCH_RUNNER_TOKEN_AGE_MS          — CCH-custom; see above
 */
export function evaluateRunnerConfigChecks(
  env: Record<string, string | undefined> = process.env,
): RunnerDoctorCheck[] {
  const checks: RunnerDoctorCheck[] = []

  // Health port: the doctor itself doesn't bind it, but a value that
  // doesn't parse means the runner will silently run without /healthz.
  const portRaw = env.SELF_HOSTED_RUNNER_HEALTH_PORT
  if (portRaw === undefined || portRaw.trim() === '') {
    checks.push({
      name: 'config_health_port',
      category: 'config',
      status: 'warn',
      detail:
        'SELF_HOSTED_RUNNER_HEALTH_PORT unset — /healthz disabled, liveness probes and self_hosted_runner_read_health have nothing to hit',
    })
  } else {
    const port = resolveRunnerHealthPort([], env)
    if (port === null) {
      checks.push({
        name: 'config_health_port',
        category: 'config',
        status: /[^0-9]/.test(portRaw.trim()) ? 'fail' : 'warn',
        detail: /[^0-9]/.test(portRaw.trim())
          ? `SELF_HOSTED_RUNNER_HEALTH_PORT='${portRaw}' does not parse as a port number`
          : `SELF_HOSTED_RUNNER_HEALTH_PORT='${portRaw}' — /healthz explicitly disabled (0 means disabled)`,
      })
    } else {
      checks.push({
        name: 'config_health_port',
        category: 'config',
        status: 'ok',
        detail: `SELF_HOSTED_RUNNER_HEALTH_PORT=${port}`,
      })
    }
  }

  // 80%-TTL token refresh clock-skew check (runbook §2 "Mid-run poll auth
  // failed on an otherwise-healthy runner ... clock skew throws off the
  // 80%-TTL refresh schedule" — the 80% point is where the token refresh
  // is SCHEDULED, not a job deadline).
  const ttlRaw = env[RUNNER_TOKEN_TTL_SEC_ENV]
  const ageRaw = env[RUNNER_TOKEN_AGE_MS_ENV]
  if (ttlRaw === undefined || ageRaw === undefined) {
    checks.push({
      name: 'token_refresh_clock_skew',
      category: 'config',
      status: 'ok',
      detail: `no token TTL configured (${RUNNER_TOKEN_TTL_SEC_ENV} / ${RUNNER_TOKEN_AGE_MS_ENV}) — 80%-TTL refresh check skipped`,
    })
  } else {
    const ttlSec = Number.parseFloat(ttlRaw)
    const sinceRefreshMs = Number.parseFloat(ageRaw)
    if (
      !Number.isFinite(ttlSec) ||
      !Number.isFinite(sinceRefreshMs) ||
      ttlSec <= 0 ||
      sinceRefreshMs < 0
    ) {
      checks.push({
        name: 'token_refresh_clock_skew',
        category: 'config',
        status: 'fail',
        detail: `token TTL env does not parse: TTL='${ttlRaw}' age='${ageRaw}' (need TTL > 0 and age >= 0)`,
      })
    } else {
      const warning = computeTokenRefreshTtlWarning(ttlSec, sinceRefreshMs)
      checks.push({
        name: 'token_refresh_clock_skew',
        category: 'config',
        status: warning === null ? 'ok' : 'warn',
        detail:
          warning ??
          `token refresh at ${Math.round((sinceRefreshMs / (ttlSec * 1000)) * 100)}% of its ${ttlSec}s TTL — below the 80% refresh point`,
      })
    }
  }

  return checks
}

/**
 * Env checks — runner identity/auth faces (runbook §1 auth chain start:
 * environment secret -> runner_token -> session_token -> inference).
 */
export function evaluateRunnerEnvChecks(
  env: Record<string, string | undefined> = process.env,
): RunnerDoctorCheck[] {
  const checks: RunnerDoctorCheck[] = []

  const runnerVersion = env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
  checks.push({
    name: 'env_runner_version',
    category: 'env',
    status: runnerVersion ? 'ok' : 'warn',
    detail: runnerVersion
      ? `runner version header present: ${runnerVersion}`
      : 'CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION unset — x-environment-runner-version header will be omitted',
  })

  const ingressToken =
    env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
    env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  checks.push({
    name: 'env_session_ingress_auth',
    category: 'env',
    status: ingressToken ? 'ok' : 'warn',
    detail: ingressToken
      ? 'session ingress auth source configured (token file / WS auth FD)'
      : 'no CLAUDE_SESSION_INGRESS_TOKEN_FILE / CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR — remote transport cannot authorize',
  })

  checks.push({
    name: 'env_environment_kind',
    category: 'env',
    status: env.CLAUDE_CODE_ENVIRONMENT_KIND ? 'ok' : 'warn',
    detail: env.CLAUDE_CODE_ENVIRONMENT_KIND
      ? `CLAUDE_CODE_ENVIRONMENT_KIND=${env.CLAUDE_CODE_ENVIRONMENT_KIND}`
      : 'CLAUDE_CODE_ENVIRONMENT_KIND unset — not running under a known environment kind',
  })

  return checks
}

function summarizeResult(checks: RunnerDoctorCheck[]): RunnerDoctorResult {
  const failed = checks.filter(c => c.status === 'fail').length
  const warned = checks.filter(c => c.status === 'warn').length
  return { checks, failed, warned, ok: failed === 0 }
}

function renderChecks(checks: RunnerDoctorCheck[]): string {
  const lines: string[] = []
  for (const check of checks) {
    const mark =
      check.status === 'ok'
        ? '[ok]'
        : check.status === 'warn'
          ? '[warn]'
          : '[fail]'
    lines.push(`${mark} ${check.name} (${check.category}): ${check.detail}`)
  }
  return lines.join('\n')
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: claude self-hosted-runner doctor [args...]',
      '',
      'Structured self-hosted runner doctor checklist (dependency / config /',
      'env) — a CCH subset of the official doctor runbook categories (the',
      'official entry is an interactive wizard over the 9-category runbook).',
      'Prints one status line per check; exits non-zero when any check',
      'fails.',
      '',
      '  --json   emit {checks, failed, warned, ok} instead of text',
      '  --help   this help',
      '',
    ].join('\n'),
  )
}

/**
 * Route runner-subcommand argv (the part after `self-hosted-runner` /
 * `environment-runner` in src/entrypoints/cli.tsx) to the doctor entry.
 * Accepts the official `doctor [...flags]` shape or a bare `--doctor`
 * flag. Returns the doctor args (help/json flags), or null when the argv
 * is not a doctor invocation.
 */
export function matchRunnerDoctorArgv(
  args: readonly string[],
): readonly string[] | null {
  if (args[0] === 'doctor') return args.slice(1)
  if (args.includes('--doctor')) return args.filter(a => a !== '--doctor')
  return null
}

/**
 * Doctor entry — mirrors the official selfHostedRunnerDoctorMain surface
 * (args in, side-effecting output, numeric exit code; the official entry
 * also returns the child process status).
 */
export async function selfHostedRunnerDoctorMain(
  args: readonly string[] = [],
  probe: RunnerDoctorProbe = DEFAULT_PROBE,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return 0
  }

  const checks: RunnerDoctorCheck[] = [
    ...evaluateRunnerDependencyChecks(probe),
    ...evaluateRunnerConfigChecks(),
    ...evaluateRunnerEnvChecks(),
  ]
  const result = summarizeResult(checks)

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    process.stdout.write(
      `self-hosted runner doctor: ${result.checks.length} checks, ${result.failed} failed, ${result.warned} warned\n${renderChecks(checks)}\n`,
    )
  }

  return result.ok ? 0 : 1
}
