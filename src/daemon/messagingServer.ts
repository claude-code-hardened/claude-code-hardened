import { createServer, type Server, type Socket } from 'net'
import { StringDecoder } from 'string_decoder'

/**
 * messagingSock — per-worker session message channel (the socket path the
 * daemon hands back in dispatch replies). After attach, clients talk to the
 * session through this channel:
 *
 *   framing   newline-delimited JSON, one request per frame, one reply
 *   verbs     send    inject input into the session (tmux send-keys /
 *                     detached stdin, engine bridge)
 *             read    read recent session output (tmux capture-pane /
 *                     log tail)
 *             status  session liveness + engine metadata
 *             close   terminate the session
 *
 * The upstream tmux path additionally carries in-band paint/idle markers
 * inside the terminal stream (OSC `\x1b_cc-d-imark;` + content_paint /
 * prompt_idle kinds) — that is an optimization for the agent view live
 * tail; the socket channel here is the durable wire contract.
 */

export type MessagingVerb = 'send' | 'read' | 'status' | 'close'

export interface MessagingRequest {
  verb: MessagingVerb
  text?: string
  lines?: number
  [k: string]: unknown
}

export interface MessagingResponse {
  ok: boolean
  verb?: string
  code?: string
  error?: string
  [k: string]: unknown
}

/** Engine bridge — adapts the message verbs to a bg session backend. */
export interface SessionBridge {
  /** Inject user input into the running session. */
  send: (text: string) => Promise<void>
  /** Read the last `lines` lines of session output. */
  read: (lines: number) => Promise<string[]>
  /** Whether the session process is still alive. */
  alive: () => boolean
  /** Terminate the session. */
  close: () => Promise<void>
  /** Engine metadata for status replies. */
  meta: () => Record<string, unknown>
}

const MAX_FRAME = 1 << 20 // 1MiB per message (ETOOLARGE guard)

export async function handleMessagingRequest(
  bridge: SessionBridge,
  req: MessagingRequest,
): Promise<MessagingResponse> {
  if (req === null || typeof req !== 'object' || typeof req.verb !== 'string') {
    return { ok: false, error: 'bad json', code: 'EUNKNOWN' }
  }
  switch (req.verb) {
    case 'send': {
      const text = typeof req.text === 'string' ? req.text : ''
      if (text.length === 0) {
        return { ok: false, verb: 'send', error: 'empty text', code: 'EPROTO' }
      }
      try {
        await bridge.send(text)
        return { ok: true, verb: 'send' }
      } catch (err) {
        return {
          ok: false,
          verb: 'send',
          error: err instanceof Error ? err.message : String(err),
          code: 'ESEND',
        }
      }
    }
    case 'read': {
      const lines = typeof req.lines === 'number' ? Math.max(1, req.lines) : 50
      try {
        const out = await bridge.read(lines)
        return { ok: true, verb: 'read', lines: out.length, output: out }
      } catch (err) {
        return {
          ok: false,
          verb: 'read',
          error: err instanceof Error ? err.message : String(err),
          code: 'EREAD',
        }
      }
    }
    case 'status':
      return {
        ok: true,
        verb: 'status',
        alive: bridge.alive(),
        ...bridge.meta(),
      }
    case 'close': {
      try {
        await bridge.close()
        return { ok: true, verb: 'close' }
      } catch (err) {
        return {
          ok: false,
          verb: 'close',
          error: err instanceof Error ? err.message : String(err),
          code: 'ECLOSE',
        }
      }
    }
    default:
      return {
        ok: false,
        error: `unknown verb: ${String(req.verb)}`,
        code: 'EUNKNOWN',
      }
  }
}

export interface MessagingServer extends Server {
  sockPath: string
}

/**
 * Bind the per-session messaging socket. Same connection flow as the
 * control server: 30s idle timeout, newline-JSON framing, one reply per
 * frame.
 */
export function createMessagingServer(
  bridge: SessionBridge,
  sockPath: string,
): MessagingServer {
  const server = createServer((socket: Socket) => {
    socket.on('error', () => socket.destroy())
    socket.setTimeout(30_000, () => socket.destroy())

    const decoder = new StringDecoder('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += decoder.write(chunk)
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.length === 0) continue
        if (line.length > MAX_FRAME) {
          socket.end(JSON.stringify({ ok: false, code: 'ETOOLARGE' }) + '\n')
          continue
        }
        let req: MessagingRequest
        try {
          req = JSON.parse(line) as MessagingRequest
        } catch {
          socket.end(
            JSON.stringify({ ok: false, error: 'bad json', code: 'EUNKNOWN' }) +
              '\n',
          )
          continue
        }
        void handleMessagingRequest(bridge, req)
          .then(resp => {
            if (!socket.destroyed) socket.end(JSON.stringify(resp) + '\n')
          })
          .catch(() => {
            if (!socket.destroyed)
              socket.end(
                JSON.stringify({
                  ok: false,
                  error: 'internal error',
                  code: 'EUNKNOWN',
                }) + '\n',
              )
          })
      }
    })
  })

  return Object.assign(server, { sockPath })
}
