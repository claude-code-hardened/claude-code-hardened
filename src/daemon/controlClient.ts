import { connect, type Socket } from 'net'
import {
  controlSockPath,
  readControlKey,
  type ControlOp,
  type ControlRequest,
  type ControlResponse,
} from './controlProtocol.js'

/**
 * Control socket client — mirrors the framing the server speaks
 * (newline-JSON, one request per frame, single reply).
 */

export async function controlRequest(
  root: string,
  op: ControlOp,
  extra: Partial<ControlRequest> = {},
  timeoutMs = 5_000,
): Promise<ControlResponse> {
  const sockPath = controlSockPath(root)
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = connect(sockPath)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
    setTimeout(() => {
      s.destroy()
      reject(new Error(`connect timeout: ${sockPath}`))
    }, timeoutMs)
  })
  try {
    const key = readControlKey()
    const req: ControlRequest = { op, ...extra, auth: key ?? undefined }
    socket.write(JSON.stringify(req) + '\n')
    return await new Promise<ControlResponse>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('reply timeout'))
      }, timeoutMs)
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8')
        const idx = buffer.indexOf('\n')
        if (idx < 0) return
        clearTimeout(timer)
        socket.destroy()
        try {
          resolve(JSON.parse(buffer.slice(0, idx)) as ControlResponse)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      socket.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
  } finally {
    if (!socket.destroyed) socket.destroy()
  }
}

export async function pingDaemon(root: string): Promise<ControlResponse> {
  return controlRequest(root, 'ping')
}
