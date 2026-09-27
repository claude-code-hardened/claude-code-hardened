import { createServer, type Server, type Socket } from 'net'
import { StringDecoder } from 'string_decoder'
import { dirname } from 'path'
import { vetAncestorOwnership } from '../daemon/daemonVet.js'
import {
  controlKeyPath,
  isValidShortId,
  peerUidReject,
  readControlKey,
  sendReply,
  verifyControlKey,
  type ControlRequest,
  type ControlResponse,
} from './controlProtocol.js'

/**
 * Control socket server — 1:1 port of the official daemon's control plane
 * (chunk-f37h5e27): peer uid gate → newline-JSON framing → op dispatch with
 * upstream's exact response shapes and error codes.
 */

/** remote IPC path refine（官方 me()）：daemon 的 IPC socket 必须是绝对路径。 */
export function refineRemoteIpcPath(p: string | undefined): string | undefined {
  if (p === undefined || p === '') return p
  if (!p.startsWith('/'))
    throw Object.assign(new Error('remote IPC path must be absolute'), {
      code: 'EPROTO',
    })
  return p
}

/**
 * JobRecord schema 对齐官方 roster worker（官方 Be）：
 * rendezvousSock 为 required（会合通道），ptySock/messagingSock optional，
 * procStart/sessionId/cliVersion/attempt/pendingRespawn 同字段名。
 */
export interface JobRecord {
  short: string
  nonce?: string
  pid: number
  /** 进程启动时刻 ms（recycled pid 判定：pidAlive 但 procStart 变化 = 复用进程） */
  procStart?: number
  /** bridge session 寻址键 */
  sessionId?: string
  /** 会合通道（官方 required） */
  rendezvousSock?: string
  /** PTY 通道 */
  ptySock?: string
  /** 消息通道 */
  messagingSock?: string
  cliVersion?: string
  startedAt?: number
  attempt?: number
  /** 重启 pending 原因（'upgrade'） */
  pendingRespawn?: 'upgrade'
  outcome?: string
  [k: string]: unknown
}

export interface JobHandle {
  record: JobRecord
  isBooting?: boolean
  isKilling?: boolean
  isRetiring?: boolean
  via?: string
  dispatch: { launch: { mode: string }; [k: string]: unknown }
  attachers: Map<string, { cols?: number; rows?: number; repaint?: () => void }>
  respawnIfIdleStale: () => Promise<Record<string, unknown>>
  alive: () => boolean
}

export interface ControlServerDeps {
  /** job registry keyed by short id (upstream: handles) */
  handles: Map<string, JobHandle>
  /** duplicate-detection registry (upstream: settled dispatches) */
  settled: Map<string, { nonce?: string; refusal?: string }>
  onDispatch: (d: Record<string, unknown>) => Promise<unknown>
  onNudge: () => void
  onShutdown: () => void
  whenReady: Promise<void>
  controlKey: string | null
  /** push a lease for a live control connection (upstream: addLease) */
  addLease: (socket: Socket, lease?: { label?: string }) => void
  removeLease: (socket: Socket) => void
  log: (line: string) => void
  telemetry: (event: string, fields?: Record<string, unknown>) => void
}

const IDLE_POLL_MS = 50

export interface ControlServer extends Server {
  /** socket dir root, for status display */
  sockPath: string
}

/**
 * Upstream qt: poll the registry for the dispatch to land, with duplicate
 * settlement semantics. Returns via sendReply on the originating socket.
 *
 * Response matrix:
 *   settled with refusal          → {ok:false, code:ECWDGONE}
 *   settled cold (worker gone)    → {ok:true, pid:0, messagingSock:"", via:"cold"}
 *   live handle, nonce match      → {ok:true, pid, messagingSock, via}
 *   live handle, nonce mismatch   → keep waiting → ESTALE on timeout
 *   timeout                       → {ok:false, code:ETIMEOUT}
 */
async function awaitDispatchSettled(
  deps: ControlServerDeps,
  socket: Socket,
  op: string,
  short: string,
  nonce: string | undefined,
  timeoutMs: number | undefined,
  dispatched?: Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs ?? 30_000, 30_000)
  let sawNonceMismatch = false
  let mismatchHandle: JobHandle | undefined
  let dispatchedValue: unknown
  let dispatchedSettled = false
  if (dispatched) {
    dispatched.then(
      v => {
        dispatchedValue = v
        dispatchedSettled = true
      },
      () => {
        dispatchedValue = 'dropped'
        dispatchedSettled = true
      },
    )
  }
  const settledState = () =>
    dispatchedValue === 'dup-live' ||
    dispatchedValue === 'dropped' ||
    dispatchedValue === 'refused' ||
    dispatchedValue === 'closed'

  while (Date.now() < deadline) {
    if (socket.destroyed) return
    const handle = deps.handles.get(short)
    const settled =
      nonce !== undefined && handle?.record.nonce !== nonce
        ? deps.settled.get(short)
        : undefined
    if (settled !== undefined && settled.nonce === nonce) {
      if (settled.refusal !== undefined) {
        return sendReply(socket, {
          ok: false,
          error: settled.refusal,
          code: 'ECWDGONE',
        })
      }
      return sendReply(socket, {
        ok: true,
        op,
        short,
        pid: 0,
        messagingSock: '',
        via: 'cold',
      })
    }
    if (handle) {
      if (nonce && handle.record.nonce !== nonce) {
        sawNonceMismatch = true
        mismatchHandle = handle.alive() ? handle : undefined
        if (settledState()) break
        if (!mismatchHandle && !sawNonceMismatch) {
          sawNonceMismatch = true
        }
        await sleep(IDLE_POLL_MS)
        continue
      }
      return sendReply(socket, {
        ok: true,
        op,
        short,
        pid: handle.record.pid,
        messagingSock: handle.record.messagingSock ?? '',
        via: handle.via,
      })
    }
    if (settledState()) break
    await sleep(IDLE_POLL_MS)
  }
  if (sawNonceMismatch) {
    if (
      mismatchHandle &&
      deps.handles.get(short) === mismatchHandle &&
      mismatchHandle.alive()
    ) {
      return sendReply(socket, {
        ok: true,
        op,
        short,
        pid: mismatchHandle.record.pid,
        messagingSock: mismatchHandle.record.messagingSock ?? '',
        via: mismatchHandle.via,
      })
    }
    return sendReply(socket, {
      ok: false,
      error:
        'a previous dispatch with this id is still being cleaned up — retry in a moment',
      code: 'ESTALE',
    })
  }
  return sendReply(socket, {
    ok: false,
    error: `daemon didn't acknowledge in time — retry`,
    code: 'ETIMEOUT',
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Upstream yn: op dispatch. The auth-gated ops (dispatch/reply/
 * permission-response) reject with EAUTH; attach without auth is a legacy
 * client — allowed via peerUid with a warn.
 */
export async function handleControlRequest(
  deps: ControlServerDeps,
  socket: Socket,
  req: ControlRequest,
): Promise<void> {
  if (req === null || typeof req !== 'object') {
    return sendReply(socket, { ok: false, error: 'bad json', code: 'EUNKNOWN' })
  }
  const authOk = verifyControlKey(req.auth, deps.controlKey)
  switch (req.op) {
    case 'ping':
      return sendReply(socket, {
        ok: true,
        op: 'ping',
        version: {
          ISSUES_EXPLAINER:
            'report the issue at https://github.com/claude-code-hardened/claude-code-hardened/issues',
        },
      })
    case 'nudge':
      deps.onNudge()
      return sendReply(socket, { ok: true, op: 'nudge' })
    case 'yield':
    case 'lease':
    case 'leases':
      return sendReply(socket, { ok: true, op: req.op })
    case 'shutdown':
      deps.log('shutdown requested via control socket')
      deps.onShutdown()
      return sendReply(socket, { ok: true, op: 'shutdown' })
    case 'list':
      return sendReply(socket, {
        ok: true,
        op: 'list',
        jobs: Array.from(deps.handles.values()).map(h =>
          h.isKilling || h.isRetiring ? { ...h.record, dying: true } : h.record,
        ),
      })
    case 'has': {
      const handle = isValidShortId(req.short)
        ? deps.handles.get(req.short)
        : undefined
      const settled = isValidShortId(req.short)
        ? deps.settled.has(req.short)
        : false
      return sendReply(socket, {
        ok: true,
        op: 'has',
        alive: (handle !== undefined && handle.alive()) || settled,
        present: handle !== undefined || settled,
        ready: handle !== undefined && !handle.isBooting,
      })
    }
    case 'await-ack':
      return awaitDispatchSettled(
        deps,
        socket,
        'await-ack',
        req.short ?? '',
        req.nonce,
        req.timeoutMs,
      )
    case 'dispatch': {
      if (!authOk) {
        return sendReply(socket, {
          ok: false,
          error:
            "dispatch rejected: this client didn't present the daemon control key",
          code: 'EAUTH',
        })
      }
      await sleep(0)
      if (socket.readableEnded || socket.destroyed) {
        deps.telemetry('cch_bg_dispatch_stale_drop')
        return
      }
      const d = (req.d ?? {}) as Record<string, unknown>
      return awaitDispatchSettled(
        deps,
        socket,
        'dispatch',
        String(d.short ?? ''),
        typeof d.nonce === 'string' ? d.nonce : undefined,
        req.timeoutMs,
        deps.onDispatch(d),
      )
    }
    case 'reply': {
      if (!authOk) {
        return sendReply(socket, {
          ok: false,
          error:
            req.auth === undefined
              ? "reply rejected: this window didn't present the daemon control key — it is likely running a Claude Code older than the daemon (left open across an update?); restart this window and retry, or stop driving the control socket directly"
              : "reply rejected: this client didn't present the daemon control key",
          code: 'EAUTH',
        })
      }
      return sendReply(socket, { ok: true, op: 'reply' })
    }
    case 'permission-response': {
      if (!authOk) {
        return sendReply(socket, {
          ok: false,
          error:
            "permission-response rejected: this client didn't present the daemon control key",
          code: 'EAUTH',
        })
      }
      return sendReply(socket, { ok: true, op: 'permission-response' })
    }
    case 'kill': {
      if (!isValidShortId(req.short)) {
        return sendReply(socket, {
          ok: false,
          error: 'bad short id',
          code: 'EPROTO',
        })
      }
      deps.settled.delete(req.short)
      const handle = deps.handles.get(req.short)
      if (!handle) {
        return sendReply(socket, {
          ok: false,
          error: 'job not found — it may have already exited',
          code: 'ENOJOB',
        })
      }
      if (handle.dispatch.launch.mode === 'exec' && handle.record.outcome) {
        deps.handles.delete(req.short)
        return sendReply(socket, { ok: true, op: 'kill' })
      }
      handle.isKilling = true
      return sendReply(socket, { ok: true, op: 'kill' })
    }
    case 'respawn-stale': {
      if (!isValidShortId(req.short)) {
        return sendReply(socket, {
          ok: false,
          error: 'bad short id',
          code: 'EPROTO',
        })
      }
      const handle = deps.handles.get(req.short)
      if (!handle) {
        return sendReply(socket, {
          ok: false,
          error: 'job not found — it may have already exited',
          code: 'ENOJOB',
        })
      }
      const result = await handle.respawnIfIdleStale()
      return sendReply(socket, { ok: true, op: 'respawn-stale', ...result })
    }
    case 'resize': {
      if (!isValidShortId(req.short)) {
        return sendReply(socket, {
          ok: false,
          error: 'bad short id',
          code: 'EPROTO',
        })
      }
      const handle = deps.handles.get(req.short)
      if (!handle) {
        return sendReply(socket, {
          ok: false,
          error: 'job not found — it may have already exited',
          code: 'ENOJOB',
        })
      }
      if (req.attachId) {
        const attacher = handle.attachers.get(req.attachId)
        if (!attacher) return sendReply(socket, { ok: true, op: 'resize' })
        attacher.cols = req.cols
        attacher.rows = req.rows
        if (attacher.repaint) {
          attacher.repaint()
          return sendReply(socket, { ok: true, op: 'resize' })
        }
      }
      return sendReply(socket, { ok: true, op: 'resize' })
    }
    case 'attach': {
      if (req.auth === undefined) {
        deps.log(
          '[bg-attach] legacy client (no control key) — allowed via peerUid',
        )
      } else if (!authOk) {
        return sendReply(socket, {
          ok: false,
          error:
            "attach rejected: the presented daemon control key doesn't match — retry, and restart the Claude Code daemon if this persists",
          code: 'EAUTH',
        })
      }
      return sendReply(socket, { ok: true, op: 'attach' })
    }
    case 'ensure-spare':
      return sendReply(socket, { ok: true, op: 'ensure-spare' })
    default:
      return sendReply(socket, {
        ok: false,
        error: 'bad json',
        code: 'EUNKNOWN',
      })
  }
}

/**
 * Bind the control socket. Connection flow mirrors upstream F:
 * destroy-after-shutdown → 30s idle timeout → peer uid gate (EPEERUID)
 * → newline-JSON frame accumulation → op dispatch.
 */
export function createControlServer(
  deps: ControlServerDeps,
  sockPath: string,
): ControlServer {
  // 闸 1+3（bind 侧）：进程身份溢出/祖先链属主 ≠ uid → ENOTOWNED
  vetAncestorOwnership(dirname(sockPath))
  const server = createServer((socket: Socket) => {
    deps.addLease(socket)
    socket.on('close', () => deps.removeLease(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(30_000, () => socket.destroy())

    const reject = peerUidReject(socket)
    if (reject) {
      socket.once('data', () =>
        sendReply(socket, { ok: false, code: 'EPEERUID', error: reject }),
      )
      return
    }

    const decoder = new StringDecoder('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += decoder.write(chunk)
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.length === 0) continue
        let req: ControlRequest
        try {
          req = JSON.parse(line) as ControlRequest
        } catch {
          sendReply(socket, { ok: false, error: 'bad json', code: 'EUNKNOWN' })
          continue
        }
        void handleControlRequest(deps, socket, req).catch(() => {
          // sendReply 自带 EPIPE 防御：内部失败只销毁连接，不打崩 daemon
          sendReply(socket, {
            ok: false,
            error: 'internal error',
            code: 'EUNKNOWN',
          })
        })
      }
    })
  })

  return Object.assign(server, { sockPath })
}

export { controlKeyPath, readControlKey }
