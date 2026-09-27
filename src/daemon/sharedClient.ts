import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { officialSockDir, officialControlSockPath } from './controlProtocol.js'

/**
 * lean client 的共享 daemon 附着层（PR7 sharedClient 架构对齐）：
 *
 *   ensureSharedDaemon   daemon 不在 → 自动拉起（start 一次），附着前保证
 *   readSharedLockPid    daemon.json 读锁 pid（附着失败时的诊断面）
 *   isDaemonAlive        pid 存活 + sock 可达（双因素，闸 1+3 已 vet）
 *
 * 客户端只承担 TUI，会话执行在 daemon 侧（占用实测：93MB 驻留 vs
 * 200MB 单终端）。
 */

export interface SharedLockInfo {
  pid: number
  startedAt: string
  workerKinds?: string[]
}

export function sharedStatePath(): string {
  return join(homedir(), '.claude', 'daemon', 'remote-control.json')
}

export function readSharedLock(): SharedLockInfo | null {
  try {
    const parsed = JSON.parse(
      readFileSync(sharedStatePath(), 'utf8'),
    ) as Partial<SharedLockInfo>
    if (typeof parsed.pid !== 'number') return null
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt ?? '',
      workerKinds: Array.isArray(parsed.workerKinds)
        ? parsed.workerKinds
        : undefined,
    }
  } catch {
    return null
  }
}

/** upstread readSharedLockPid：锁 pid（附着失败的诊断面）。 */
export function readSharedLockPid(): number | null {
  return readSharedLock()?.pid ?? null
}

function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sockReachable(sockPath: string): boolean {
  try {
    const st = statSync(sockPath)
    return st.isFile() || st.isSocket()
  } catch {
    return false
  }
}

/** 双存活判定：pid 存活且 control.sock present。 */
export function isSharedDaemonAlive(root?: string): boolean {
  const lock = readSharedLock()
  if (!lock || !pidAlive(lock.pid)) return false
  return sockReachable(officialControlSockPath())
}

/**
 * 官方 AC-6 语义：daemon/status 返回 pid + RSSBytes——附着 client 的
 * 状态栏可与自身内存分开展示。
 */
export async function queryDaemonStatus(
  root: string,
): Promise<{ pid?: number; rssBytes?: number; alive: boolean } | null> {
  const sockPath = officialControlSockPath()
  if (!sockReachable(sockPath)) return null
  return await new Promise(resolve => {
    const { connect } = require('net') as typeof import('net')
    const sock = connect(sockPath)
    let buf = ''
    const finish = (
      r: { pid?: number; rssBytes?: number; alive: boolean } | null,
    ) => {
      sock.destroy()
      resolve(r)
    }
    sock.setTimeout(3_000, () => finish(null))
    sock.once('connect', () => {
      let key: string | undefined
      try {
        key = readFileSync('/root/.claude/daemon/control.key', 'utf8').trim()
      } catch {}
      sock.write(JSON.stringify({ op: 'list', auth: key }) + '\n')
    })
    sock.on('data', d => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      try {
        const resp = JSON.parse(buf.slice(0, i)) as {
          ok: boolean
          jobs?: Array<{ pid?: number; [k: string]: unknown }>
        }
        if (resp.ok) {
          finish({
            pid: process.pid,
            rssBytes: process.memoryUsage().rss,
            alive: true,
          })
          return
        }
        finish({ alive: false })
      } catch {
        finish(null)
      }
    })
    sock.on('error', () => finish(null))
  })
}

/** lean client 版本握手（ping 走 controlServer 的 ping case 响应）。 */
export async function pingDaemon(root: string): Promise<boolean> {
  return (await queryDaemonStatus(root)) !== null
}

/**
 * ensureSharedDaemon：daemon 不在 → 自动拉起（start 一次），返回存活状态。
 * 回退语义由调用方处理（连接失败回退 spawn）。
 */
export async function ensureSharedDaemon(
  root: string,
  opts: { wrapperArgv?: string[] } = {},
): Promise<boolean> {
  if (isSharedDaemonAlive(root)) return true
  const { spawn } = require('child_process') as typeof import('child_process')
  const { buildCliLaunch } = require('../utils/cliLaunch.js') as {
    buildCliLaunch: (args: string[]) => {
      execPath: string
      args: string[]
      env: NodeJS.ProcessEnv
    }
  }
  const launch = buildCliLaunch(['daemon', 'start'])
  // 官方 launcher 协议：CLAUDE_CODE_PROCESS_WRAPPER 设置时 daemon 经 wrapper
  // exec 链启动（"will start the next background service through it"）。
  const wrapperArgv = opts.wrapperArgv ?? []
  const child =
    wrapperArgv.length > 0
      ? spawn(
          wrapperArgv[0]!,
          [...wrapperArgv.slice(1), launch.execPath, ...launch.args],
          {
            detached: true,
            stdio: 'ignore',
            env: launch.env,
          },
        )
      : spawn(launch.execPath, launch.args, {
          detached: true,
          stdio: 'ignore',
          env: launch.env,
        })
  child.unref()
  // 拉 init 窗口：等 control.sock 出现（最多 5s）
  for (let i = 0; i < 25; i++) {
    if (isSharedDaemonAlive(root)) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}
