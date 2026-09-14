/**
 * Integration tests for the fork-module startup profiling checkpoints.
 *
 * The fork added new feature modules (daemon / bridge / ACP / templates /
 * workflow / launch command family / weixin) that sit on hot startup paths.
 * The profiler instrumentation must stay non-invasive, so these tests verify:
 *
 *  1. When detailed profiling is disabled (no CLAUDE_CODE_PROFILE_STARTUP),
 *     profileCheckpoint / profileReport are zero-side-effect no-ops: nothing
 *     throws and no report file is written.
 *  2. Every checkpoint added to the fork modules follows the existing
 *     `<module>_<stage>` naming convention (source-level regex assertions)
 *     and each module registers its documented checkpoints.
 *  3. When detailed profiling IS enabled, the fork-module checkpoints show
 *     up in the STARTUP PROFILING REPORT written under CLAUDE_CONFIG_DIR
 *     (verified in a subprocess with a clean module graph).
 */
import { describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { logMock } from '../mocks/log.js'
import { debugMock } from '../mocks/debug.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

/**
 * Fork-module files that carry new startup checkpoints, paired with the
 * exact checkpoint names each file must register. Keep in sync with the
 * perf/profiling branch instrumentation.
 */
const FORK_MODULE_CHECKPOINTS: Array<[string, string[]]> = [
  [
    'src/daemon/main.ts',
    ['daemon_entry', 'daemon_supervisor_started', 'daemon_worker_spawn'],
  ],
  [
    'src/daemon/workerRegistry.ts',
    ['daemon_worker_entry', 'daemon_worker_bridge_start'],
  ],
  [
    'src/bridge/bridgeMain.ts',
    [
      'bridge_entry',
      'bridge_after_config_init',
      'bridge_register_start',
      'bridge_registered',
      'bridge_loop_start',
    ],
  ],
  [
    'src/services/acp/entry.ts',
    ['acp_entry', 'acp_env_applied', 'acp_connection_ready'],
  ],
  ['src/services/acp/agent/AcpAgent.ts', ['acp_initialize_received']],
  [
    'src/services/acp/agent/sessionLifecycle.ts',
    ['acp_session_create_start', 'acp_session_created'],
  ],
  [
    'src/cli/handlers/templateJobs.ts',
    ['templates_entry', 'templates_job_created'],
  ],
  ['src/jobs/templates.ts', ['templates_list_start', 'templates_list_end']],
  [
    'src/workflow/service.ts',
    [
      'workflow_service_init_start',
      'workflow_service_init_end',
      'workflow_launch_start',
      'workflow_persisted_runs_start',
      'workflow_persisted_runs_loaded',
    ],
  ],
  ['src/commands/schedule/launchSchedule.tsx', ['launch_schedule_start']],
  [
    'src/commands/skill-store/launchSkillStore.tsx',
    ['launch_skill_store_start'],
  ],
  [
    'packages/weixin/src/server.ts',
    [
      'weixin_entry',
      'weixin_account_loaded',
      'weixin_server_connected',
      'weixin_poll_started',
    ],
  ],
]

/** Allowed checkpoint module prefixes for the fork's new feature modules. */
const FORK_MODULE_PREFIXES = [
  'daemon',
  'bridge',
  'acp',
  'templates',
  'workflow',
  'launch',
  'weixin',
]

/** `<module>_<stage>` shape: lowercase segments joined by underscores. */
const CHECKPOINT_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/

/**
 * Fork fast-path processes that exit outside the main.tsx / gracefulShutdown
 * report outlets, mapped to the minimum number of profileReport() call sites
 * each file must have. Without a flush on the exit path, the checkpoints
 * these processes record are never persisted to startup-perf/<sid>.txt.
 */
const FAST_PATH_REPORT_OUTLETS: Array<[string, number]> = [
  ['src/entrypoints/cli.tsx', 1],
  ['src/daemon/workerRegistry.ts', 1],
  ['src/bridge/bridgeMain.ts', 1],
  ['src/services/acp/entry.ts', 1],
  ['packages/weixin/src/server.ts', 2],
]

describe('startup profiler: fork-module checkpoints', () => {
  test('profiler calls are no-ops when profiling is disabled', async () => {
    const {
      profileCheckpoint,
      profileReport,
      isDetailedProfilingEnabled,
      getStartupPerfLogPath,
    } = await import('../../src/utils/startupProfiler.js')

    // CI must not enable detailed profiling for this suite to be valid.
    expect(isDetailedProfilingEnabled()).toBe(false)

    expect(() => {
      profileCheckpoint('daemon_entry')
      profileCheckpoint('bridge_registered')
      profileCheckpoint('acp_session_created')
      profileCheckpoint('weixin_poll_started')
    }).not.toThrow()

    const reportPath = getStartupPerfLogPath()
    const existedBefore = existsSync(reportPath)
    expect(() => profileReport()).not.toThrow()
    expect(existsSync(reportPath)).toBe(existedBefore)
  })

  test('checkpoint names follow the <module>_<stage> convention', () => {
    for (const [relFile, expectedNames] of FORK_MODULE_CHECKPOINTS) {
      const source = readFileSync(join(REPO_ROOT, relFile), 'utf-8')
      const names = [
        ...source.matchAll(/profileCheckpoint\(\s*'([^']+)'/g),
      ].map(match => match[1] as string)

      expect(names.length, `${relFile} has checkpoints`).toBeGreaterThan(0)
      for (const name of names) {
        expect(
          name,
          `${relFile}: '${name}' must match <module>_<stage>`,
        ).toMatch(CHECKPOINT_NAME_PATTERN)
        const prefix = name.split('_')[0] as string
        expect(
          FORK_MODULE_PREFIXES,
          `${relFile}: unknown module prefix '${prefix}'`,
        ).toContain(prefix)
      }
      // NOTE: duplicate checkpoint names within a file are allowed — e.g.
      // bridge_register_start/_registered fire in both the interactive and
      // the headless registration paths of bridgeMain.ts.

      // Every documented checkpoint must be registered in its file.
      for (const name of expectedNames) {
        expect(
          source.includes(`profileCheckpoint('${name}')`),
          `${relFile} must register '${name}'`,
        ).toBe(true)
      }
    }
  })

  // Startup → REPL homepage → interactive pipeline checkpoints. These live
  // outside the fork feature modules (main / ink mount / REPL screen / query
  // loop), so they are asserted separately from FORK_MODULE_CHECKPOINTS —
  // whose <module> prefix whitelist (daemon/bridge/acp/...) does not cover
  // the repl_*/action_* names.
  const REPL_PIPELINE_CHECKPOINTS: Array<[string, string[]]> = [
    ['src/main.tsx', ['action_commands_joined', 'mcp_connections_kicked']],
    [
      'src/interactiveHelpers.tsx',
      ['repl_ink_mount_start', 'repl_ink_mount_done'],
    ],
    ['src/screens/REPL.tsx', ['repl_screen_mount_effect_done']],
    ['src/components/PromptInput/PromptInput.tsx', ['repl_prompt_ready']],
    ['src/query.ts', ['skillsearch_prefetch_kicked']],
  ]

  test('REPL pipeline checkpoints are registered in sources', () => {
    for (const [relFile, expectedNames] of REPL_PIPELINE_CHECKPOINTS) {
      const source = readFileSync(join(REPO_ROOT, relFile), 'utf-8')
      for (const name of expectedNames) {
        expect(
          name,
          `${relFile}: '${name}' must match <module>_<stage>`,
        ).toMatch(CHECKPOINT_NAME_PATTERN)
        expect(
          source.includes(`profileCheckpoint('${name}')`),
          `${relFile} must register '${name}'`,
        ).toBe(true)
      }
    }
  })

  test('ink log-update registers frame checkpoints', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages/@ant/ink/src/core/log-update.ts'),
      'utf-8',
    )
    // First visible frame of the REPL homepage.
    expect(source).toContain("profileCheckpoint('repl_ink_first_frame')")
    // Frame stalls are dynamic — a unique name per stall with the gap
    // encoded, so marks stay unique and memorySnapshots stay order-aligned.
    expect(source).toMatch(
      /profileCheckpoint\(\s*`render_stall_\$\{stallCount\}_\$\{Math\.round\(frameGap\)\}ms`,?\s*\)/,
    )
  })

  test('fork fast-path processes flush profileReport before exiting', () => {
    for (const [relFile, minCalls] of FAST_PATH_REPORT_OUTLETS) {
      const source = readFileSync(join(REPO_ROOT, relFile), 'utf-8')
      const calls = source.match(/profileReport\(\)/g)?.length ?? 0
      const message = `${relFile} must flush profileReport() on its exit path — without it the fork-module checkpoints are never persisted`
      expect(calls, message).toBeGreaterThanOrEqual(minCalls)
    }
  })

  test('fork fast-path report flush precedes process.exit', () => {
    // ACP and weixin serve processes exit via process.exit() inside their own
    // entrypoints (they never return through cli.tsx), so the flush must be
    // ordered before the exit to have any effect.
    for (const relFile of [
      'src/services/acp/entry.ts',
      'packages/weixin/src/server.ts',
    ]) {
      const source = readFileSync(join(REPO_ROOT, relFile), 'utf-8')
      const flushIdx = source.indexOf('profileReport()')
      const exitIdx = source.indexOf('process.exit(')
      expect(flushIdx, `${relFile} flushes the profile`).toBeGreaterThan(-1)
      expect(exitIdx, `${relFile} exits via process.exit`).toBeGreaterThan(-1)
      expect(flushIdx < exitIdx, `${relFile} flushes before exit`).toBe(true)
    }
  })

  test('launchCommand derives checkpoint names from commandName', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'src/commands/_shared/launchCommand.ts'),
      'utf-8',
    )
    expect(source).toMatch(
      /profileCheckpoint\(\s*`launch_\$\{checkpointSegment\(opts\.commandName\)\}_start`\s*,?\s*\)/,
    )
    expect(source).toMatch(
      /profileCheckpoint\(\s*`launch_\$\{checkpointSegment\(opts\.commandName\)\}_dispatched`\s*,?\s*\)/,
    )
    // Dash-containing command names (vault, memory-stores, ...) must be
    // sanitized to underscores so checkpoint names stay <module>_<stage>.
    expect(source).toMatch(/replace\(\/\[\^a-zA-Z0-9\]\+\/g, '_'\)/)
  })

  test('fork checkpoints appear in the enabled-profiling report', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'ccb-startup-perf-'))
    try {
      const entryUrl = pathToFileURL(
        join(REPO_ROOT, 'src/utils/startupProfiler.js'),
      ).href
      const script = `
        const profiler = await import(${JSON.stringify(entryUrl)})
        profiler.profileCheckpoint('daemon_entry')
        profiler.profileCheckpoint('daemon_supervisor_started')
        profiler.profileCheckpoint('acp_session_created')
        profiler.profileCheckpoint('weixin_poll_started')
        profiler.profileCheckpoint('workflow_service_init_end')
        profiler.profileReport()
      `
      const proc = Bun.spawnSync([process.execPath, '-e', script], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CLAUDE_CODE_PROFILE_STARTUP: '1',
          CLAUDE_CONFIG_DIR: configDir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(
        proc.exitCode,
        `subprocess failed: ${proc.stderr.toString()}`,
      ).toBe(0)

      const reportDir = join(configDir, 'startup-perf')
      const files = readdirSync(reportDir)
      expect(files.length).toBe(1)
      const report = readFileSync(join(reportDir, files[0] as string), 'utf-8')

      expect(report).toContain('STARTUP PROFILING REPORT')
      const expectedInReport = [
        'daemon_entry',
        'daemon_supervisor_started',
        'acp_session_created',
        'weixin_poll_started',
        'workflow_service_init_end',
      ]
      for (const name of expectedInReport) {
        expect(report).toContain(name)
      }

      // Report lines: [+  123.456ms] (+   12.345ms) checkpoint_name | RSS: ...
      const linePattern = /\[\+\s*\d+\.\d+ms\] \(\+\s*\d+\.\d+ms\) (\S+) \|/
      let matchedLines = 0
      for (const line of report.split('\n')) {
        const match = line.match(linePattern)
        if (match) {
          matchedLines++
          expect(match[1]).toMatch(CHECKPOINT_NAME_PATTERN)
        }
      }
      expect(matchedLines).toBeGreaterThanOrEqual(expectedInReport.length)

      expect(report).toMatch(/Total startup time: \d+\.\d+ms/)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
