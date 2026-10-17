import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'

import { errorMessage } from '../utils/errors.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { ServerConfig } from './types.js'

/**
 * Constant-time bearer comparison: plain string equality leaks the token
 * byte-by-byte through response timing on the reachable listener surface.
 */
function bearerMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false
  const expectedBuf = Buffer.from(`Bearer ${expected}`, 'utf8')
  const providedBuf = Buffer.from(provided, 'utf8')
  if (providedBuf.length !== expectedBuf.length) {
    // Burn equivalent time so a length mismatch is not observable either.
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return timingSafeEqual(providedBuf, expectedBuf)
}

/**
 * Minimal real HTTP server for `claude server` (DIRECT_CONNECT).
 *
 * Call protocol (deduced from createDirectConnectSession /
 * directConnectManager — the client side of this same repo):
 *   GET    /health        → {ok, pid, port, sessions}
 *   POST   /sessions      → Bearer auth, body {cwd?, dangerously_skip_permissions?}
 *                            → 200 {session_id, ws_url, work_dir?} (connectResponseSchema)
 *   DELETE /sessions/:id  → stop one session (optional manager support)
 *   upgrade /ws/:id       → WebSocket pipe to the session subprocess
 *
 * TODO(下一代): 官方 _ALL.js 的服务器侧回执账本机制（deliveryLedger /
 * flushInternalEvents）— 每条下行 SDK 消息登记、客户端 ack 后清算，重连时
 * 重放未确认消息。接口已留（DeliveryLedgerLike / setDeliveryLedger），
 * 未接线，当前消息为 fire-and-forget。
 */

/** What startServer needs from the SessionManager (structural — no import cycle). */
export interface ManagedSessionDescriptor {
  id: string
  wsUrl: string
  workDir?: string
}

export interface SessionManagerLike {
  createSession(input: {
    cwd?: string
    dangerouslySkipPermissions?: boolean
    wsBaseUrl?: string
  }): Promise<ManagedSessionDescriptor>
  destroySession?(id: string): Promise<boolean>
  destroyAll(): Promise<void>
  stop?(closeActiveConnections: boolean): void
  sessionCount?(): number
  handleUpgrade?(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean
}

/**
 * Official _ALL.js delivery ledger shape — reserved, not yet wired.
 * record() on outbound, ack() on client confirmation, flushAcks() persisted
 * during backpressure/idle, replay on reconnect.
 */
export interface DeliveryLedgerLike {
  record(sessionId: string, messageId: string): void
  ack(sessionId: string, messageId: string): void
  flushAcks(): Promise<void>
}

let deliveryLedger: DeliveryLedgerLike | null = null

export function setDeliveryLedger(ledger: DeliveryLedgerLike | null): void {
  deliveryLedger = ledger
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(jsonStringify(body))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        // 1MB cap — a session-create body never needs more.
        if (!done) {
          done = true
          resolve('')
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
    req.on('error', () => {
      if (!done) {
        done = true
        resolve('')
      }
    })
  })
}

export const startServer: (
  config: ServerConfig,
  sessionManager: SessionManagerLike,
  logger?: { info?: (message: string) => void },
) => Promise<{
  port?: number
  stop: (closeActiveConnections: boolean) => void
}> = async (config, sessionManager, logger) => {
  const log = (msg: string): void => {
    if (logger?.info) {
      logger.info(msg)
    } else {
      process.stderr.write(`[server] ${msg}\n`)
    }
  }

  const httpServer = http.createServer((req, res) => {
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      pathname = '/'
    }
    const method = req.method ?? 'GET'

    // Authentication — every route except /health requires the bearer token
    // when one is configured (main.tsx always generates `sk-ant-cc-...`).
    // Comparison is constant-time: the listener surface is network-reachable.
    if (config.authToken && pathname !== '/health') {
      if (!bearerMatches(req.headers.authorization, config.authToken)) {
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }
    }

    if (method === 'GET' && pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        pid: process.pid,
        ...(typeof actualPort === 'number' ? { port: actualPort } : {}),
        sessions: sessionManager.sessionCount?.() ?? 0,
      })
      return
    }

    if (method === 'POST' && pathname === '/sessions') {
      void (async () => {
        let body: Record<string, unknown> = {}
        try {
          const raw = await readBody(req)
          if (raw !== '') {
            const parsed = jsonParse(raw) as unknown
            if (typeof parsed === 'object' && parsed !== null) {
              body = parsed as Record<string, unknown>
            }
          }
        } catch {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }

        if (
          typeof config.maxSessions === 'number' &&
          config.maxSessions > 0 &&
          (sessionManager.sessionCount?.() ?? 0) >= config.maxSessions
        ) {
          writeJson(res, 503, { error: 'maximum concurrent sessions reached' })
          return
        }

        // ws URL is built from OUR bind address, never the request Host
        // header (a spoofed Host would aim clients at a third-party box),
        // and never reflects an external hostname.
        const wsHost =
          !config.host || config.host === '0.0.0.0' || config.host === '::'
            ? '127.0.0.1'
            : config.host
        const session = await sessionManager.createSession({
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
          ...(body.dangerously_skip_permissions === true && {
            dangerouslySkipPermissions: true,
          }),
          wsBaseUrl: `ws://${wsHost}:${actualPort ?? config.port}`,
        })
        writeJson(res, 200, {
          session_id: session.id,
          ws_url: session.wsUrl,
          ...(session.workDir !== undefined && { work_dir: session.workDir }),
        })
      })().catch(err => {
        writeJson(res, 500, { error: errorMessage(err) })
      })
      return
    }

    const deleteMatch =
      method === 'DELETE' ? /^\/sessions\/([\w-]+)$/.exec(pathname) : null
    if (deleteMatch) {
      if (!sessionManager.destroySession) {
        writeJson(res, 501, { error: 'not implemented' })
        return
      }
      void sessionManager
        .destroySession(deleteMatch[1] ?? '')
        .then(removed => {
          if (removed) {
            writeJson(res, 200, { ok: true })
          } else {
            writeJson(res, 404, { error: 'unknown session' })
          }
        })
        .catch(err => {
          writeJson(res, 500, { error: errorMessage(err) })
        })
      return
    }

    writeJson(res, 404, { error: 'not found' })
  })

  // WebSocket upgrade — bearer check here, wiring delegated to the manager.
  httpServer.on('upgrade', (req, socket, head) => {
    if (
      config.authToken &&
      !bearerMatches(req.headers.authorization, config.authToken)
    ) {
      socket.destroy()
      return
    }
    if (!sessionManager.handleUpgrade?.(req, socket, head)) {
      socket.destroy()
    }
  })

  httpServer.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
  })

  let actualPort: number | undefined

  const listening = new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(
        new Error(
          `Failed to start server on ${config.unix ? `unix:${config.unix}` : `${config.host}:${config.port}`}: ${errorMessage(err)}`,
        ),
      )
    }
    httpServer.once('error', onError)
    const onListening = (): void => {
      httpServer.removeListener('error', onError)
      // Post-bind errors (socket teardown, EMFILE on new conns) previously
      // had no handler and crashed the whole server process.
      httpServer.on('error', err => {
        process.stderr.write(`[server] runtime error: ${errorMessage(err)}\n`)
      })
      resolve()
    }
    if (config.unix) {
      httpServer.listen({ path: config.unix }, onListening)
    } else {
      httpServer.listen({ port: config.port, host: config.host }, onListening)
    }
  })

  // Banner discipline: the caller only prints after this await resolves, so
  // "listening" is printed from a truthy socket, never a speculative one.
  await listening
  const address = httpServer.address()
  if (address && typeof address === 'object') {
    actualPort = address.port
  }
  log(
    config.unix
      ? `listening on unix:${config.unix}`
      : `listening on ${config.host}:${actualPort ?? config.port}`,
  )
  if (deliveryLedger) {
    void deliveryLedger.flushAcks()
  }

  return {
    port: actualPort,
    stop(closeActiveConnections: boolean): void {
      httpServer.close()
      if (closeActiveConnections) {
        sessionManager.stop?.(true)
      }
      // TODO(下一代): flush deliveryLedger on graceful shutdown once wired.
    },
  }
}
