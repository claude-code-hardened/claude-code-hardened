import { spawn } from 'node:child_process'
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
 * TODO(下一代): idle sweep using `opts.idleTimeoutMs` (detached-session
 * expiry) and persistence of SessionIndex entries to
 * ~/.claude/server-sessions.json for cross-restart resume (see types.ts).
 */

type ManagedSession = {
  info: SessionInfo
  ws: WebSocket | null
}

export type SessionManagerOpts = {
  idleTimeoutMs?: number
  maxSessions?: number
  /** Sessions are confined under this root (cwd escape is rejected). */
  workspace?: string
  /** Opt-in gate for client-requested --dangerously-skip-permissions. */
  allowDangerousSkipPermissions?: boolean
}

export class SessionManager {
  private backend: DangerousBackend
  private opts: SessionManagerOpts
  private sessions = new Map<string, ManagedSession>()
  private wss: WebSocketServer

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
    if (
      workDir !== workspaceRoot &&
      !workDir.startsWith(workspaceRoot + path.sep)
    ) {
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

    child.on('error', () => {
      info.status = 'stopped'
      record.ws?.close(1011, 'subprocess failed to start')
    })
    child.on('exit', () => {
      info.status = 'stopped'
      record.ws?.close(1000, 'session ended')
      record.ws = null
    })

    // stdout line-buffer → WebSocket
    let stdoutBuf = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
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

  async destroySession(id: string): Promise<boolean> {
    const record = this.sessions.get(id)
    if (!record) return false
    record.info.status = 'stopped'
    try {
      record.info.process?.kill('SIGTERM')
    } catch (err) {
      process.stderr.write(
        `[server] failed to kill session ${id}: ${errorMessage(err)}\n`,
      )
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
      await this.destroySession(id)
    }
    this.wss.close()
  }

  stop(closeActiveConnections: boolean): void {
    if (closeActiveConnections) {
      void this.destroyAll()
    }
  }
}
