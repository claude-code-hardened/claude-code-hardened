import { describe, expect, test } from 'bun:test'
import {
  RUNNER_TOKEN_AGE_MS_ENV,
  RUNNER_TOKEN_TTL_SEC_ENV,
} from '../runnerDoctor.js'
import type { RunnerDoctorProbe } from '../runnerDoctor.js'
import {
  evaluateRunnerConfigChecks,
  evaluateRunnerDependencyChecks,
  evaluateRunnerEnvChecks,
  matchRunnerDoctorArgv,
  selfHostedRunnerDoctorMain,
} from '../runnerDoctor.js'

const FULL_PROBE: RunnerDoctorProbe = {
  which: bin => `/usr/bin/${bin}`,
  pathReadable: async () => true,
}

const EMPTY_PROBE: RunnerDoctorProbe = {
  which: () => undefined,
  pathReadable: async () => false,
}

describe('evaluateRunnerConfigChecks', () => {
  test('health port unset warns so probe hits are never assumed', () => {
    const checks = evaluateRunnerConfigChecks({})
    const health = checks.find(c => c.name === 'config_health_port')
    expect(health?.status).toBe('warn')
    expect(health?.category).toBe('config')
  })

  test('valid health port is ok; 0 is an explicit disable (warn)', () => {
    const valid = evaluateRunnerConfigChecks({
      SELF_HOSTED_RUNNER_HEALTH_PORT: '8080',
    }).find(c => c.name === 'config_health_port')
    expect(valid?.status).toBe('ok')
    expect(valid?.detail).toContain('8080')

    const disabled = evaluateRunnerConfigChecks({
      SELF_HOSTED_RUNNER_HEALTH_PORT: '0',
    }).find(c => c.name === 'config_health_port')
    expect(disabled?.status).toBe('warn')
    expect(disabled?.detail).toContain('disabled')
  })

  test('unparsable health port fails', () => {
    const failed = evaluateRunnerConfigChecks({
      SELF_HOSTED_RUNNER_HEALTH_PORT: 'http',
    }).find(c => c.name === 'config_health_port')
    expect(failed?.status).toBe('fail')
  })

  test('token TTL unset skips the 80% refresh check as ok', () => {
    const check = evaluateRunnerConfigChecks({}).find(
      c => c.name === 'token_refresh_clock_skew',
    )
    expect(check?.status).toBe('ok')
    expect(check?.detail).toContain('skipped')
  })

  test('token TTL past the 80% refresh point surfaces the warning text', () => {
    const check = evaluateRunnerConfigChecks({
      [RUNNER_TOKEN_TTL_SEC_ENV]: '1000',
      [RUNNER_TOKEN_AGE_MS_ENV]: '900000',
    }).find(c => c.name === 'token_refresh_clock_skew')
    expect(check?.status).toBe('warn')
    expect(check?.detail).toContain('clock skew')
  })

  test('token TTL below the 80% refresh point stays ok; unparsable TTL fails', () => {
    const okCheck = evaluateRunnerConfigChecks({
      [RUNNER_TOKEN_TTL_SEC_ENV]: '1000',
      [RUNNER_TOKEN_AGE_MS_ENV]: '100000',
    }).find(c => c.name === 'token_refresh_clock_skew')
    expect(okCheck?.status).toBe('ok')

    const failed = evaluateRunnerConfigChecks({
      [RUNNER_TOKEN_TTL_SEC_ENV]: 'abc',
      [RUNNER_TOKEN_AGE_MS_ENV]: '100000',
    }).find(c => c.name === 'token_refresh_clock_skew')
    expect(failed?.status).toBe('fail')
  })

  test('NEGATIVE TTL / age values fail instead of silently reporting ok', () => {
    const negativeTtl = evaluateRunnerConfigChecks({
      [RUNNER_TOKEN_TTL_SEC_ENV]: '-5',
      [RUNNER_TOKEN_AGE_MS_ENV]: '100',
    }).find(c => c.name === 'token_refresh_clock_skew')
    expect(negativeTtl?.status).toBe('fail')
    expect(negativeTtl?.detail).toContain("TTL='-5'")

    const negativeAge = evaluateRunnerConfigChecks({
      [RUNNER_TOKEN_TTL_SEC_ENV]: '1000',
      [RUNNER_TOKEN_AGE_MS_ENV]: '-1',
    }).find(c => c.name === 'token_refresh_clock_skew')
    expect(negativeAge?.status).toBe('fail')
  })

  test('CCH-custom env names are declared, not official surfaces', () => {
    expect(RUNNER_TOKEN_TTL_SEC_ENV).toBe('CCH_RUNNER_TOKEN_TTL_SEC')
    expect(RUNNER_TOKEN_AGE_MS_ENV).toBe('CCH_RUNNER_TOKEN_AGE_MS')
  })
})

describe('evaluateRunnerDependencyChecks', () => {
  test('kubectl/docker missing warns, git missing fails (session precondition)', () => {
    const checks = evaluateRunnerDependencyChecks(EMPTY_PROBE)
    for (const bin of ['kubectl', 'docker']) {
      const check = checks.find(c => c.name === `dependency_${bin}`)
      expect(check?.status).toBe('warn')
      expect(check?.category).toBe('dependency')
    }
    const git = checks.find(c => c.name === 'dependency_git')
    expect(git?.status).toBe('fail')
  })

  test('all dependencies present are ok with resolved paths as detail', () => {
    const checks = evaluateRunnerDependencyChecks(FULL_PROBE)
    expect(checks.every(c => c.status === 'ok')).toBe(true)
    const kubectl = checks.find(c => c.name === 'dependency_kubectl')
    expect(kubectl?.detail).toContain('/usr/bin/kubectl')
  })
})

describe('evaluateRunnerEnvChecks', () => {
  test('full runner env yields all-ok env section', () => {
    const checks = evaluateRunnerEnvChecks({
      CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION: '2.1.284',
      CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/run/secrets/token',
      CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
    })
    expect(checks).toHaveLength(3)
    expect(checks.every(c => c.status === 'ok')).toBe(true)
    expect(checks.every(c => c.category === 'env')).toBe(true)
  })

  test('missing runner identity faces warn with actionable detail', () => {
    const checks = evaluateRunnerEnvChecks({})
    expect(checks.every(c => c.status === 'warn')).toBe(true)
    const version = checks.find(c => c.name === 'env_runner_version')
    expect(version?.detail).toContain('CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION')
  })
})

describe('matchRunnerDoctorArgv (CLI wiring router)', () => {
  test('routes the official `doctor [...]` subcommand shape', () => {
    expect(matchRunnerDoctorArgv(['doctor'])).toEqual([])
    expect(matchRunnerDoctorArgv(['doctor', '--json'])).toEqual(['--json'])
    expect(matchRunnerDoctorArgv(['doctor', '--help'])).toEqual(['--help'])
  })

  test('routes a bare --doctor flag and strips it', () => {
    expect(matchRunnerDoctorArgv(['--doctor'])).toEqual([])
    expect(matchRunnerDoctorArgv(['--doctor', '--json'])).toEqual(['--json'])
  })

  test('returns null for non-doctor argv so unknown subcommands are rejected', () => {
    expect(matchRunnerDoctorArgv([])).toBeNull()
    expect(matchRunnerDoctorArgv(['orchestrator'])).toBeNull()
  })
})

describe('selfHostedRunnerDoctorMain', () => {
  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    return { lines, restore: () => (process.stdout.write = original) }
  }

  test('all-ok probe exits 0 and prints structured text', async () => {
    const { lines, restore } = captureStdout()
    try {
      const code = await selfHostedRunnerDoctorMain([], FULL_PROBE)
      expect(code).toBe(0)
      const out = lines.join('')
      expect(out).toContain('self-hosted runner doctor')
      expect(out).toContain('[ok] dependency_git')
      expect(out).toContain('token_refresh_clock_skew')
    } finally {
      restore()
    }
  })

  test('warning-only run exits 0; fail (git missing) exits 1', async () => {
    const { lines, restore } = captureStdout()
    try {
      // Empty probe: kubectl/docker missing -> warn (no fail), git missing -> fail.
      const failCode = await selfHostedRunnerDoctorMain([], EMPTY_PROBE)
      expect(failCode).toBe(1)

      // Warns only (deps ok, no env/config failures) stay exit 0.
      const warnOnly = await selfHostedRunnerDoctorMain([], {
        which: bin => `/usr/bin/${bin}`,
        pathReadable: async () => true,
      })
      expect(warnOnly).toBe(0)
      const out = lines.join('')
      expect(out).toContain('[warn] config_health_port')
    } finally {
      restore()
    }
  })

  test('--json emits a {checks, failed, warned, ok} payload; --help exits 0', async () => {
    const { lines, restore } = captureStdout()
    try {
      const code = await selfHostedRunnerDoctorMain(['--json'], FULL_PROBE)
      expect(code).toBe(0)
      const parsed = JSON.parse(lines[0]!) as {
        checks: unknown[]
        failed: number
        warned: number
        ok: boolean
      }
      expect(Array.isArray(parsed.checks)).toBe(true)
      expect(parsed.ok).toBe(parsed.failed === 0)

      const helpCode = await selfHostedRunnerDoctorMain(['--help'])
      expect(helpCode).toBe(0)
      const help = lines.join('')
      expect(help).toContain('claude self-hosted-runner doctor')
    } finally {
      restore()
    }
  })
})
