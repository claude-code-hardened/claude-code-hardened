import { connect, type Socket } from 'net'
import type { MessagingRequest, MessagingResponse } from './messagingServer.js'

/** messagingSock client — one request, one reply (newline-JSON). */
export async function messagingRequest(
  sockPath: string,
  verb: MessagingRequest['verb'],
  extra: Partial<MessagingRequest> = {},
  timeoutMs = 5_000,
): Promise<MessagingResponse> {
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
    socket.write(JSON.stringify({ verb, ...extra }) + '\n')
    return await new Promise<MessagingResponse>((resolve, reject) => {
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
          resolve(JSON.parse(buffer.slice(0, idx)) as MessagingResponse)
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
