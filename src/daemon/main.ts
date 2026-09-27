import { t } from '../i18n/index.js'
import { type ChildProcess } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { buildCliLaunch, spawnCli } from '../utils/cliLaunch.js'
import {
  writeDaemonState,
  removeDaemonState,
  queryDaemonStatus,
  stopDaemonByPid,
} from './state.js'
import {
  acquireLock,
  readLock,
  clearLock,
  signalableByCurrentUser,
} from './daemonLock.js'
import { officialSockDir, officialControlSockPath } from './controlProtocol.js'
import { createMessagingServer } from './messagingServer.js'
import { ensureControlKey, type ControlRequest } from './controlProtocol.js'
import {
  createControlServer,
  type ControlServer,
  type JobHandle,
} from './controlServer.js'

/**
 * Exit code used by workers for permanent (non-retryable) failures.
 * @see workerRegistry.ts EXIT_CODE_PERMANENT
 */
const EXIT_CODE_PERMANENT = 78

/**
 * Backoff config for restarting crashed workers.
 */
const BACKOFF_INITIAL_MS = 2_000
const BACKOFF_CAP_MS = 120_000
const BACKOFF_MULTIPLIER = 2
const MAX_RAPID_FAILURES = 5 // Park worker after this many fast crashes

interface WorkerState {
  kind: string
  process: ChildProcess | null
  backoffMs: number
  failureCount: number
  parked: boolean
  lastStartTime: number
  restartTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Daemon supervisor entry point. Called from `cli.tsx` via:
 *   `claude daemon [subcommand]`
 *
 * Manages the daemon supervisor AND background sessions under one namespace.
 *
 * Subcommands:
 *   (none)  — unified status (supervisor + sessions)
 *   start   — start the supervisor with default workers
 *   stop    — send SIGTERM to supervisor
 *   status  — unified status (supervisor + sessions)
 *   ps      — alias for status
 *   bg      — start a background session
 *   attach  — attach to a background session
 *   logs    — show session logs
 *   kill    — kill a session
 */
export async function daemonMain(args: string[]): Promise<void> {
  profileCheckpoint('daemon_entry')
  const subcommand = args[0] || 'status'

  switch (subcommand) {
    // --- Supervisor management ---
    case 'start':
    case 'run': // 官方别名：piped 场景下前台 supervisor 是默认形态
      await runSupervisor(args.slice(1))
      break
    case 'install':
    case 'service-install':
      // 官方此版本同样禁用："Service install is disabled in this version —
      // the daemon runs on demand and exits when the last client disconnects."
      console.log(
        t(
          'Service install is disabled in this version — the daemon runs on\ndemand and exits when the last client disconnects.\nUse `cch daemon start` to run the supervisor explicitly.',
        ),
      )
      break
    case 'restart':
      await handleDaemonStop()
      await runSupervisor(args.slice(1))
      break
    case 'uninstall':
      // 无已安装 service（launchctl/systemd 未注册），对齐官方幂等语义
      console.log('no installed service found — nothing to uninstall')
      break
    case 'stop': {
      // 官方 flags：--any 也停 transient（非 service）daemon；
      // --keep-workers 留 detached 会话跑（不终止后台会话）
      const keepWorkers = args.includes('--keep-workers')
      const anyDaemon = args.includes('--any')
      await handleDaemonStop({ keepWorkers, anyDaemon })
      break
    }

    // --- Unified status ---
    case 'status':
      await showUnifiedStatus()
      break

    case 'logs': {
      // 官方语义：Tail the daemon log (Ctrl-C to stop)
      const bg = await import('../cli/bg.js')
      await bg.logsHandler(args[1])
      break
    }

    case '--help':
    case '-h':
    case 'help':
      printHelp()
      break
    default:
      console.error(`未知的 daemon 子命令：${subcommand}`)
      printHelp()
      process.exitCode = 1
  }
}

function printHelp(): void {
  console.log(`用法：cch daemon [子命令] [选项]

服务生命周期：
  run [json-path]   前台运行 supervisor（管道场景下的默认形态）
  status            显示 daemon pid、版本、运行时长
  logs              尾随 daemon 日志（Ctrl-C 停止）
  uninstall         移除后台服务（launchctl/systemd）
  stop              关闭 supervisor 并终止后台会话
                      --any           同时停止 transient（非 service）daemon
                      --keep-workers  保留 detached 会话继续运行
  install           安装为 launchctl/systemd 服务（跨重启持久）
  start             启动已安装的服务
  restart           重启已安装的服务

REPL
  /daemon [子命令]    交互模式下可用同样的命令`)
}

/**
 * Show unified status: daemon supervisor + background sessions.
 */
async function showUnifiedStatus(): Promise<void> {
  // 官方面板形态：daemon 状态行 → launcher 行 → sock dir / control.sock
  // 可达性 → bg workers roster → bg sessions 明细
  const lock = readLock()
  if (!lock || !signalableByCurrentUser(lock.pid)) {
    console.log('未在运行')
  } else {
    const startedAt = Date.parse(lock.startedAt)
    const uptimeSec = Number.isFinite(startedAt)
      ? Math.round((Date.now() - startedAt) / 1000)
      : -1
    console.log(
      `daemon：运行中 (pid=${lock.pid}，来源=${lock.origin}，已运行 ${uptimeSec} 秒)`,
    )
  }
  console.log(`启动器：${getLauncherRecord() ?? '（无运行中的）'}`)

  const sockDir = officialSockDir()
  const sockPath = officialControlSockPath()
  console.log(`\n后台会话：`)
  console.log(`  sock 目录：  ${sockDir}`)
  const reachable = existsSync(sockPath)
  console.log(`  control.sock：${reachable ? '在' : '缺失'} (${sockPath})`)
  const { listLiveSessions } = await import('../cli/bg.js')
  const bgSessions = await listLiveSessions()
  console.log(
    `  后台 worker：${bgSessions.length > 0 ? `${bgSessions.length} 个存活` : 'roster.json 中 0 个（control 不可达）'}`,
  )

  console.log('\n=== 后台会话 ===')
  const bg = await import('../cli/bg.js')
  await bg.psHandler([])
}

/** binary 的 mtime（upgrade 轮询用），取不到时返回 null。 */
function getExecMtime(): number | null {
  try {
    return statSync(process.execPath).mtimeMs
  } catch {
    return null
  }
}

/** 官方 status 的 launcher 行：记录下一个 background service 经由的启动器。 */
function getLauncherRecord(): string | null {
  try {
    const wrapper = process.env['SHELL']
    if (!wrapper) return null
    return `当前 cch 解析到 \`${wrapper}\`，下一个后台服务将经由它启动`
  } catch {
    return null
  }
}

/**
 * Stop a running daemon from another CLI process.
 */
async function handleDaemonStop(
  opts: { keepWorkers?: boolean; anyDaemon?: boolean } = {},
): Promise<void> {
  const result = queryDaemonStatus()

  if (result.status === 'stopped') {
    if (opts.anyDaemon) {
      // --any：transient daemon 本就不写 service 状态，幂等提示
      console.log('no transient daemon running')
      return
    }
    console.log('daemon 未在运行')
    return
  }

  if (result.status === 'stale') {
    console.log('daemon was stale (cleaned up)')
    return
  }

  console.log(`stopping daemon (PID: ${result.state!.pid})...`)
  const stopped = await stopDaemonByPid()

  if (stopped) {
    console.log(
      opts.keepWorkers
        ? 'daemon stopped (detached sessions left running)'
        : 'daemon stopped',
    )
  } else {
    console.log('daemon could not be stopped (may have already exited)')
  }
}

/**
 * Parse supervisor arguments from CLI.
 */
function parseSupervisorArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--dir' && i + 1 < args.length) {
      result.dir = resolve(args[++i]!)
    } else if (arg.startsWith('--dir=')) {
      result.dir = resolve(arg.slice('--dir='.length))
    } else if (arg === '--spawn-mode' && i + 1 < args.length) {
      result.spawnMode = args[++i]!
    } else if (arg.startsWith('--spawn-mode=')) {
      result.spawnMode = arg.slice('--spawn-mode='.length)
    } else if (arg === '--capacity' && i + 1 < args.length) {
      result.capacity = args[++i]!
    } else if (arg.startsWith('--capacity=')) {
      result.capacity = arg.slice('--capacity='.length)
    } else if (arg === '--permission-mode' && i + 1 < args.length) {
      result.permissionMode = args[++i]!
    } else if (arg.startsWith('--permission-mode=')) {
      result.permissionMode = arg.slice('--permission-mode='.length)
    } else if (arg === '--sandbox') {
      result.sandbox = '1'
    } else if (arg === '--name' && i + 1 < args.length) {
      result.name = args[++i]!
    } else if (arg.startsWith('--name=')) {
      result.name = arg.slice('--name='.length)
    }
  }
  return result
}

/**
 * Run the daemon supervisor loop. Spawns workers and restarts them
 * on crash with exponential backoff.
 */
async function runSupervisor(args: string[]): Promise<void> {
  const config = parseSupervisorArgs(args)
  const dir = config.dir || resolve('.')

  console.log(`[daemon] supervisor starting in ${dir}`)

  const workers: WorkerState[] = [
    {
      kind: 'remoteControl',
      process: null,
      backoffMs: BACKOFF_INITIAL_MS,
      failureCount: 0,
      parked: false,
      lastStartTime: 0,
      restartTimer: null,
    },
  ]

  // Write daemon state file so other CLI processes can query/stop us
  writeDaemonState({
    pid: process.pid,
    cwd: dir,
    startedAt: new Date().toISOString(),
    workerKinds: workers.map(w => w.kind),
    lastStatus: 'running',
  })

  const controller = new AbortController()
  profileCheckpoint('daemon_supervisor_started')

  // ── daemon.lock acquisition (official handshake) ──
  const lockResult = acquireLock('transient')
  if (lockResult.status === 'held') {
    console.log(
      `[daemon] daemon.lock held by pid=${lockResult.holder.pid} (origin=${lockResult.holder.origin}) — a supervisor is already running`,
    )
    return
  }
  if (lockResult.status === 'replaced-stale') {
    console.log('[daemon] replacing stale daemon.lock (previous holder exited)')
  }

  // displaced probing: once the lock moves to another pid, yield and exit
  let displaced = false
  const displacedProbe = setInterval(() => {
    if (controller.signal.aborted || displaced) return
    const current = readLock()
    if (current && current.pid !== process.pid) {
      displaced = true
      exitCause = 'displaced'
      console.log(
        `[daemon] lockfile now held by pid=${current.pid} — displaced, yielding`,
      )
      shutdown()
    }
  }, 2_000)

  // ── Control socket (official-daemon wire contract, 1:1) ──
  const controlKey = ensureControlKey()
  const handles = new Map<string, JobHandle>()
  const settled = new Map<string, { nonce?: string; refusal?: string }>()
  const leases = new Set<unknown>()
  let exitCause = 'unknown'

  // on-demand idle exit + upgrade self-restart (official
  // tengu_daemon_self_restart_on_upgrade semantics: exit with cause=upgrade
  // and let the next invocation pick up the new binary)
  const IDLE_EXIT_MS = 5_000
  // upgrade 轮询：对比 execPath 的 mtime（binary 被升级替换后变化）。
  // MACRO.VERSION 是编译期常量，进程内读两次永远相同，不能用。
  const spawnMtime = getExecMtime()
  // 显式 start 的 supervisor 在第一个 client 到来前保持常驻；
  // everHadClient 之后 idle（无 lease 且无 live worker）才退出。
  let everHadClient = false
  let idleTimer: ReturnType<typeof setInterval> | null = null
  idleTimer = setInterval(() => {
    if (controller.signal.aborted) return
    if (!everHadClient) return
    if (leases.size > 0) return
    const liveWorker = workers.some(
      w => w.process && w.process.exitCode === null,
    )
    if (liveWorker) return
    const mtime = getExecMtime()
    if (spawnMtime !== null && mtime !== null && mtime !== spawnMtime) {
      exitCause = 'upgrade'
      console.log('[daemon] binary replaced on disk — self restart on upgrade')
      shutdown()
      return
    }
    exitCause = 'idle_exit'
    shutdown()
  }, IDLE_EXIT_MS)

  const pidAlive = (pid: number): boolean => {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  let controlServer: ControlServer | null = null
  try {
    controlServer = createControlServer(
      {
        handles,
        settled,
        onDispatch: async d => {
          // dispatch → spawn a bg session via the engine abstraction
          // (upstream: qt dispatch with server-issued short/nonce)
          const { selectEngine } = await import('../cli/bg/engines/index.js')
          const engine = await selectEngine()
          const short = randomBytes(4).toString('hex')
          const nonce = randomUUID()
          const sessionName = `claude-bg-${short}`
          const args = Array.isArray(d['args'])
            ? (d['args'] as string[])
            : ['-p', String(d['prompt'] ?? '')]
          const logPath = join(
            getClaudeConfigHomeDir(),
            'sessions',
            'logs',
            `${sessionName}.log`,
          )
          const result = await engine.start({
            sessionName,
            args,
            env: { ...process.env },
            logPath,
            cwd: typeof d['cwd'] === 'string' ? d['cwd'] : dir,
          })
          const record = {
            short,
            nonce,
            pid: result.pid,
            procStart: Date.now(),
            messagingSock: '',
            rendezvousSock: join(officialSockDir(), `rv-${short}.sock`),
            rvAuth: randomBytes(16).toString('hex'),
            ptyAuth: randomBytes(16).toString('hex'),
            cliVersion: (MACRO as { VERSION?: string }).VERSION,
            startedAt: Date.now(),
            attempt: 0,
            name: result.sessionName,
            logPath: result.logPath,
            engine: result.engineUsed,
          }
          // messagingSock：每会话操作通道（send/read/status/close），
          // dispatch 响应带回（官方 wire contract）
          const messagingSock = join(officialSockDir(), `msg-${short}.sock`)
          const tmux = result.engineUsed === 'tmux'
          const bridge = {
            send: async (text: string) => {
              const { execFile } = await import('child_process')
              if (tmux) {
                await new Promise<void>((res, rej) =>
                  execFile(
                    'tmux',
                    ['send-keys', '-t', result.sessionName, '-l', text],
                    e => (e ? rej(e) : res()),
                  ),
                )
                await new Promise<void>((res, rej) =>
                  execFile(
                    'tmux',
                    ['send-keys', '-t', result.sessionName, 'Enter'],
                    e => (e ? rej(e) : res()),
                  ),
                )
              } else {
                // detached 引擎：输入经会话日志不可达，报错给客户端
                throw new Error('detached sessions do not accept input')
              }
            },
            read: async (lines: number) => {
              if (tmux) {
                const { execFile } = await import('child_process')
                return await new Promise<string[]>((res, rej) =>
                  execFile(
                    'tmux',
                    [
                      'capture-pane',
                      '-p',
                      '-t',
                      result.sessionName,
                      '-S',
                      String(-lines),
                    ],
                    (e, stdout) =>
                      e ? rej(e) : res(String(stdout).split('\n')),
                  ),
                )
              }
              // detached：tail 日志
              try {
                const content = readFileSync(result.logPath, 'utf8')
                return content.split('\n').slice(-lines)
              } catch {
                return []
              }
            },
            alive: () => pidAlive(result.pid),
            close: async () => {
              try {
                process.kill(result.pid, 'SIGTERM')
              } catch {
                // already gone
              }
              handles.delete(short)
            },
            meta: () => ({
              engine: result.engineUsed,
              name: result.sessionName,
            }),
          }
          let messagingServer:
            | import('./messagingServer.js').MessagingServer
            | null = null
          try {
            messagingServer = createMessagingServer(bridge, messagingSock)
            await new Promise<void>((res, rej) => {
              messagingServer!.once('error', rej)
              messagingServer!.listen(messagingSock, () => res())
            })
          } catch {
            messagingServer = null
          }
          record.messagingSock = messagingServer ? messagingSock : ''
          handles.set(short, {
            record,
            dispatch: { launch: { mode: 'exec' } },
            attachers: new Map(),
            respawnIfIdleStale: async () => {
              if (pidAlive(result.pid)) return { respawned: false, alive: true }
              // exec-mode session died: drop the handle, close messaging, settle
              messagingServer?.close()
              handles.delete(short)
              settled.set(short, { nonce })
              return { respawned: false, removed: true }
            },
            alive: () => pidAlive(result.pid),
          })
          return {
            dispatched: true,
            short,
            nonce,
            pid: result.pid,
            messagingSock: record.messagingSock,
          }
        },
        onNudge: () => {},
        onShutdown: () => {
          exitCause = 'shutdown_op'
          shutdown()
        },
        whenReady: Promise.resolve(),
        controlKey,
        addLease: socket => {
          everHadClient = true
          leases.add(socket)
        },
        removeLease: socket => {
          leases.delete(socket)
        },
        log: line => console.log(`[daemon] ${line}`),
        telemetry: event => {
          console.log(`[daemon] ${event}`)
        },
      },
      officialControlSockPath(),
    )
    // sockDir 必须先建：listen 一个不存在目录里的 socket → Bun 报
    // "Failed to listen on unix socket"（实测，2026-09-27）。官方在
    // STo()/roster 写入路径里递归建目录，这里对齐。
    mkdirSync(dirname(officialControlSockPath()), {
      recursive: true,
      mode: 0o700,
    })
    await new Promise<void>((resolve, reject) => {
      controlServer!.once('error', reject)
      controlServer!.listen(officialControlSockPath(), () => resolve())
    })
    console.log(`[daemon] control socket bound at ${officialControlSockPath()}`)
  } catch (err) {
    console.warn(
      `[daemon] control socket unavailable: ${err instanceof Error ? err.message : String(err)}`,
    )
    controlServer = null
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('[daemon] supervisor shutting down...')
    controller.abort()
    if (displacedProbe) clearInterval(displacedProbe)
    if (idleTimer) clearInterval(idleTimer)
    if (exitCause !== 'displaced') clearLock()
    removeDaemonState()
    if (controlServer) {
      controlServer.close()
      controlServer = null
    }
    for (const w of workers) {
      if (w.restartTimer) {
        clearTimeout(w.restartTimer)
        w.restartTimer = null
      }
      if (w.process && !w.process.killed) {
        w.process.kill('SIGTERM')
      }
    }
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Spawn and supervise workers
  for (const worker of workers) {
    if (!controller.signal.aborted) {
      spawnWorker(worker, dir, config, controller.signal)
    }
  }

  // Wait for abort signal
  await new Promise<void>(resolve => {
    if (controller.signal.aborted) {
      resolve()
      return
    }
    controller.signal.addEventListener('abort', () => resolve(), { once: true })
  })

  // Wait for all workers to exit
  await Promise.all(
    workers
      .filter(w => w.process && w.process.exitCode === null)
      .map(
        w =>
          new Promise<void>(resolve => {
            if (!w.process || w.process.exitCode !== null) {
              resolve()
              return
            }
            let killTimer: ReturnType<typeof setTimeout> | null = null
            w.process.on('exit', () => {
              if (killTimer) {
                clearTimeout(killTimer)
                killTimer = null
              }
              resolve()
            })
            // Force kill after grace period
            killTimer = setTimeout(() => {
              if (w.process && w.process.exitCode === null) {
                w.process.kill('SIGKILL')
              }
              resolve()
            }, 30_000)
            killTimer.unref?.()
          }),
      ),
  )

  console.log('[daemon] supervisor stopped')
}

/**
 * Spawn a worker child process with the appropriate env vars.
 */
function spawnWorker(
  worker: WorkerState,
  dir: string,
  config: Record<string, string>,
  signal: AbortSignal,
): void {
  if (signal.aborted || worker.parked) return

  worker.lastStartTime = Date.now()

  const env: Record<string, string | undefined> = {
    ...process.env,
    DAEMON_WORKER_DIR: dir,
    DAEMON_WORKER_NAME: config.name,
    DAEMON_WORKER_SPAWN_MODE: config.spawnMode || 'same-dir',
    DAEMON_WORKER_CAPACITY: config.capacity || '4',
    DAEMON_WORKER_PERMISSION: config.permissionMode,
    DAEMON_WORKER_SANDBOX: config.sandbox || '0',
    DAEMON_WORKER_CREATE_SESSION: '1',
    CLAUDE_CODE_SESSION_KIND: 'daemon-worker',
  }

  console.log(`[daemon] spawning worker '${worker.kind}'`)
  // 诊断（unknown option 排查）：打印 supervisor 视角的最终 argv——
  // BOOTSTRAP_ARGS 来自 sanitizeExecArgv(process.execArgv)，bun 11673
  // 在 compile 单文件下会把 app 参数泄漏进 execArgv，若 sanitize 漏滤
  // 会拼出 ['daemon','start','--daemon-worker=…'] 这样的畸形 argv
  if (process.env['DAEMON_DEBUG'] === '1') {
    console.log(
      `[daemon][debug] execArgv=${JSON.stringify(process.execArgv)} argv=${JSON.stringify(process.argv)}`,
    )
  }

  const launch = buildCliLaunch([`--daemon-worker=${worker.kind}`], { env })
  if (process.env['DAEMON_DEBUG'] === '1') {
    console.log(`[daemon][debug] worker args=${JSON.stringify(launch.args)}`)
  }

  const child = spawnCli(launch, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  worker.process = child
  profileCheckpoint('daemon_worker_spawn')

  // Pipe worker stdout/stderr to supervisor with prefix
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n')
    for (const line of lines) {
      console.log(`  ${line}`)
    }
  })
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n')
    for (const line of lines) {
      console.error(`  ${line}`)
    }
  })

  child.on('exit', (code, sig) => {
    worker.process = null

    if (signal.aborted) {
      // Supervisor is shutting down, don't restart
      return
    }

    if (code === EXIT_CODE_PERMANENT) {
      console.error(
        `[daemon] worker '${worker.kind}' exited with permanent error — parking`,
      )
      worker.parked = true
      return
    }

    // Check for rapid failure (crashed within 10s of starting)
    const runDuration = Date.now() - worker.lastStartTime
    if (runDuration < 10_000) {
      worker.failureCount++
      if (worker.failureCount >= MAX_RAPID_FAILURES) {
        console.error(
          `[daemon] worker '${worker.kind}' failed ${worker.failureCount} times rapidly — parking`,
        )
        worker.parked = true
        return
      }
    } else {
      // Ran for a reasonable time, reset failure count
      worker.failureCount = 0
      worker.backoffMs = BACKOFF_INITIAL_MS
    }

    console.log(
      `[daemon] worker '${worker.kind}' exited (code=${code}, signal=${sig}), restarting in ${worker.backoffMs}ms`,
    )

    worker.restartTimer = setTimeout(() => {
      worker.restartTimer = null
      if (!signal.aborted && !worker.parked) {
        spawnWorker(worker, dir, config, signal)
      }
    }, worker.backoffMs)
    worker.restartTimer.unref?.()

    // Exponential backoff
    worker.backoffMs = Math.min(
      worker.backoffMs * BACKOFF_MULTIPLIER,
      BACKOFF_CAP_MS,
    )
  })
}
