import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { errorMessage } from '../utils/errors.js'
import type {
  DangerousBackend,
  SpawnCommand,
} from './backends/dangerousBackend.js'
import type { SessionInfo } from './types.js'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * In-process session registry. Each session is a real `claude` subprocess
 * running in stream-json mode; its stdout lines are relayed over the
 * session's WebSocket and inbound WebSocket messages are piped to its stdin.
 *
 * Registry lifecycle (CCH server extension — official 2.8.4 has no HTTP/WSS
 * session server; verified against docs/reverse-284/ where the only
 * "sessions" route is the cloud API `/v1/code/sessions/`): a record occupies
 * a maxSessions slot, so the entry MUST be removed the moment its subprocess
 * is gone — stopped-forever residue would eventually 503 every new session.
 * Kill escalation follows the official detached-process backstop pattern
 * (SIGTERM → grace timer → SIGKILL; see 0001-chunk-xrzcaagk
 * module-006-uncategorized.js, `BJt=1500` backstop).
 *
 * TODO(下一代): idle sweep using `opts.idleTimeoutMs` (detached-session
 * expiry) and persistence of SessionIndex entries to
 * ~/.claude/server-sessions.json for cross-restart resume (see types.ts).
 */

type ManagedSession = {
  info: SessionInfo
  ws: WebSocket | null
  /** Epoch ms the record entered 'stopped' (sweep-TTL base). */
  stoppedAt?: number
}

/** Grace between the destroy SIGTERM and the SIGKILL backstop. */
const DEFAULT_KILL_GRACE_MS = 5_000

/** Residual 'stopped' records older than this are swept from the registry. */
const STOPPED_RECORD_TTL_MS = 5 * 60_000

/** Sweep cadence for 'stopped' residue (belt-and-braces for the exit path). */
const STOPPED_SWEEP_INTERVAL_MS = 60_000

/** stdout line-buffer cap: a broken child without line breaks must not
 * grow the relay buffer without bound (tailing entries are dropped lines). */
const STDOUT_BUFFER_LIMIT_BYTES = 1024 * 1024

export type SessionManagerOpts = {
  idleTimeoutMs?: number
  maxSessions?: number
  /** Sessions are confined under this root (cwd escape is rejected). */
  workspace?: string
  /** Opt-in gate for client-requested --dangerously-skip-permissions. */
  allowDangerousSkipPermissions?: boolean
  /** SIGTERM→SIGKILL grace for destroySession (testable override). */
  killGraceMs?: number
}

export class SessionManager {
  private backend: DangerousBackend
  private opts: SessionManagerOpts
  private sessions = new Map<string, ManagedSession>()
  private wss: WebSocketServer
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(backend: DangerousBackend, opts: SessionManagerOpts = {}) {
    this.backend = backend
    this.opts = opts
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
    // workspace/allow-dangerous flags are honored per-createSession.
  }

  sessionCount(): number {
    return this.sessions.size
  }

  async createSession(input: {
    cwd?: string
    dangerouslySkipPermissions?: boolean
    wsBaseUrl?: string
  }): Promise<{ id: string; wsUrl: string; workDir: string }> {
    // Sessions are confined to the --workspace root: a client-supplied cwd
    // with path escape (`../../`) would otherwise give any token holder a
    // free-run of the filesystem.
    const workspaceRoot = path.resolve(this.opts.workspace ?? process.cwd())
    const workDir = path.resolve(input.cwd ?? workspaceRoot)
    // A6 audit: startsWith(root+sep) degenerates when root is '/' ('//' never
    // matches) — path.relative + escape check is root-invariant.
    const rel = path.relative(workspaceRoot, workDir)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `session cwd escapes the server workspace (${workspaceRoot}): ${workDir}`,
      )
    }
    // --dangerously-skip-permissions is opt-in at server start; requested
    // but not allowed downgrades silently (fail-safe) — the client is told
    // via workDir/session shape only, never granted the escalated mode.
    const spawned: SpawnCommand = this.backend.buildSpawnCommand({
      dangerouslySkipPermissions:
        input.dangerouslySkipPermissions === true &&
        this.opts.allowDangerousSkipPermissions === true,
    })

    const child = spawn(spawned.command, spawned.args, {
      cwd: workDir,
      env: spawned.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const id = randomUUID()
    const info: SessionInfo = {
      id,
      status: 'running',
      createdAt: Date.now(),
      workDir,
      process: child,
      sessionKey: id,
    }
    const record: ManagedSession = { info, ws: null }
    this.sessions.set(id, record)

    // A dead subprocess must not keep occupying a maxSessions slot: both the
    // exit and the error path deregister the record (Map.delete is
    // idempotent, so error+exit double-fire — or destroySession having
    // removed the entry first — never double-deletes a live record; the ws
    // close idempotence comes from record.ws being nulled here first).
    const deregister = (closeCode: 1000 | 1011, reason: string): void => {
      info.status = 'stopped'
      record.stoppedAt = Date.now()
      record.ws?.close(closeCode, reason)
      record.ws = null
      this.sessions.delete(id)
    }
    child.on('error', () => deregister(1011, 'subprocess failed to start'))
    child.on('exit', () => deregister(1000, 'session ended'))

    // stdout line-buffer → WebSocket
    let stdoutBuf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      // Bound the relay buffer: a child that never emits '\n' would otherwise
      // grow it without limit. Prefer dropping complete lines from the head
      // so the next relayed line is not a truncated JSON fragment.
      if (stdoutBuf.length > STDOUT_BUFFER_LIMIT_BYTES) {
        const cut = stdoutBuf.indexOf(
          '\n',
          stdoutBuf.length - STDOUT_BUFFER_LIMIT_BYTES,
        )
        stdoutBuf =
          cut !== -1
            ? stdoutBuf.slice(cut + 1)
            : stdoutBuf.slice(stdoutBuf.length - STDOUT_BUFFER_LIMIT_BYTES)
      }
      let idx = stdoutBuf.indexOf('\n')
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (line !== '') {
          record.ws?.send(line)
        }
        idx = stdoutBuf.indexOf('\n')
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[server/session ${id.slice(0, 8)}] ${chunk}`)
    })

    // Registry maintenance sweeps run only while sessions exist.
    this.ensureStoppedSweep()

    const base = input.wsBaseUrl ?? 'ws://localhost'
    return { id, wsUrl: `${base}/ws/${id}`, workDir }
  }

  /** Attach an incoming /ws/<id> upgrade to its session. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = /^\/ws\/([\w-]+)$/.exec(url.pathname)
    if (!match) return false
    const id = match[1] ?? ''
    const record = this.sessions.get(id)
    if (!record || record.info.status === 'stopped') return false

    this.wss.handleUpgrade(req, socket, head, ws => {
      record.ws = ws
      ws.on('message', data => {
        const payload = typeof data === 'string' ? data : data.toString()
        if (record.info.process?.stdin?.writable) {
          record.info.process.stdin.write(`${payload}\n`)
        }
      })
      ws.on('close', () => {
        record.ws = null
        // Client went away — terminate the subprocess so nothing idles.
        void this.destroySession(id)
      })
    })
    return true
  }

  /**
   * SIGTERM first, then a SIGKILL backstop if the subprocess ignores it —
   * the official detached-process lifecycle escalates the same way
   * (0001-chunk-xrzcaagk: `Ab(n,"SIGTERM")` + `setTimeout(...,"SIGKILL")`
   * backstop timer). The backstop timer never keeps the server process alive.
   */
  private killEscalating(child: ChildProcess): void {
    try {
      child.kill('SIGTERM')
    } catch (err) {
      process.stderr.write(
        `[server] failed to kill session subprocess: ${errorMessage(err)}\n`,
      )
    }
    const graceMs = this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    const backstop = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
      } catch {
        // already dead
      }
    }, graceMs)
    backstop.unref()
    child.once('exit', () => clearTimeout(backstop))
  }

  async destroySession(id: string): Promise<boolean> {
    const record = this.sessions.get(id)
    if (!record) return false
    record.info.status = 'stopped'
    record.stoppedAt = Date.now()
    const child = record.info.process
    if (child) {
      this.killEscalating(child)
    }
    try {
      record.ws?.close(1001, 'session terminated')
    } catch {
      // socket already gone
    }
    record.ws = null
    this.sessions.delete(id)
    return true
  }

  async destroyAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      // Per-session isolation: one poisoned session must not leak the rest
      // (loser-path cleanup calls this during double-acquire teardown).
      try {
        await this.destroySession(id)
      } catch (error) {
        console.error('[sessionManager] destroySession failed:', error)
      }
    }
    this.wss.close()
  }

  stop(closeActiveConnections: boolean): void {
    if (closeActiveConnections) {
      void this.destroyAll()
    }
    // The HTTP server is stopping: either sessions go with it
    // (closeActiveConnections) or the process is going away — either way
    // registry maintenance has nothing left to maintain.
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * Belt-and-braces complement to the exit-path deregistration: any record
   * that somehow lingers in 'stopped' past the TTL is removed outright, so
   * dead registry entries can never permanently consume maxSessions slots.
   */
  private ensureStoppedSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(
      () => this.sweepStoppedRecords(),
      STOPPED_SWEEP_INTERVAL_MS,
    )
    // Never block server shutdown on the sweep.
    this.sweepTimer.unref()
  }

  private sweepStoppedRecords(): void {
    const now = Date.now()
    for (const [id, record] of this.sessions) {
      if (
        record.info.status === 'stopped' &&
        record.stoppedAt !== undefined &&
        now - record.stoppedAt > STOPPED_RECORD_TTL_MS
      ) {
        this.sessions.delete(id)
      }
    }
    if (this.sessions.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}
