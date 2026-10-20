import type { ServerConfig } from './types.js'
import { urlHostFor } from './bindHost.js'

/**
 * Startup banner for `claude server`. Called by main.tsx only after the
 * socket is truly bound (server.port is the kernel-assigned port when
 * --port 0), so it never prints a speculative URL.
 */
export const printBanner: (
  config: ServerConfig,
  authToken: string,
  port: number,
) => void = (config, authToken, port) => {
  // A6 audit: `--host ::1` must yield `http://[::1]:port` / `cc://…@[::1]:port`
  // — an unbracketed IPv6 literal makes both URLs unparsable.
  const urlHost = urlHostFor(config.host)
  const httpUrl = config.unix
    ? `unix:${config.unix}`
    : `http://${urlHost}:${port}`
  const lines = [
    `claude server listening on ${httpUrl}`,
    `auth token: ${authToken}`,
    `auth header: Authorization: Bearer ${authToken}`,
    `connect: claude open ${config.unix ? `cc+unix://${config.unix}` : `cc://${authToken}@${urlHost}:${port}`}`,
  ]
  process.stderr.write(`\n${lines.join('\n')}\n\n`)
}
