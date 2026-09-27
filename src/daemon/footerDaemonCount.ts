import { readFileSync } from 'fs'
import { officialControlSockPath } from './controlProtocol.js'

/**
 * footer 的 daemon 会话数指示——client 侧模块级缓存 + 低频轮询：
 *
 *   startDaemonSessionCountPoller   footer 挂载时启动（单例，5s 一次）
 *   getDaemonSessionCount           同步取缓存（null = daemon 不在/未查询）
 *
 * 渲染不阻塞：查询是异步裸 socket（ping 语义，control plane 闸 1+3 已
 * vet），失败静默保留旧值。
 */

let cachedCount: number | null = null
let pollerStarted = false
let pollTimer: ReturnType<typeof setInterval> | null = null

export function getDaemonSessionCount(): number | null {
  return cachedCount
}

export function stopDaemonSessionCountPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollerStarted = false
}

/** 单例轮询：5s 一次 list，取 jobs 长度（空闲 5s 语义由 daemon 侧 lease 决定，这里只读）。 */
export function startDaemonSessionCountPoller(intervalMs = 5_000): void {
  if (pollerStarted) return
  pollerStarted = true
  const query = () => {
    void queryOnce()
  }
  query()
  pollTimer = setInterval(query, intervalMs)
  pollTimer.unref?.()
}

async function queryOnce(): Promise<void> {
  await new Promise<void>(resolve => {
    const { connect } = require('net') as typeof import('net')
    let settled = false
    const finish = async () => {
      if (!settled) {
        settled = true
        // control 不可达 → 兜底 roster.json（与 /daemon 面板的 bg workers 同源）
        try {
          const { listLiveSessions } =
            require('../cli/bg.js') as typeof import('../cli/bg.js')
          cachedCount = (await listLiveSessions()).length
        } catch {
          cachedCount = null
        }
        resolve()
      }
    }
    let sock: ReturnType<typeof connect>
    try {
      sock = connect(officialControlSockPath())
    } catch {
      void finish()
      return
    }
    sock.setTimeout(2_000, () => {
      sock.destroy()
      void finish()
    })
    let buf = ''
    sock.once('connect', () => {
      let key: string | undefined
      try {
        key = readFileSync('/root/.claude/daemon/control.key', 'utf8').trim()
      } catch {}
      const nonce = require('crypto').randomBytes(32).toString('hex') as string
      sock.write(
        JSON.stringify({
          op: 'list',
          nonce,
          auth: require('./peerAuth.js').signChallenge(key, nonce),
        }) + '\n',
      )
    })
    sock.on('data', d => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      try {
        const resp = JSON.parse(buf.slice(0, i)) as {
          ok: boolean
          jobs?: unknown[]
        }
        if (resp.ok) {
          cachedCount = Array.isArray(resp.jobs) ? resp.jobs.length : 0
        } else {
          cachedCount = null
        }
      } catch {}
      sock.destroy()
      void finish()
    })
    sock.on('error', () => void finish())
  })
}
