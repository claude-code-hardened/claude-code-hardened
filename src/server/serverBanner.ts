import type { ServerConfig } from './types.js'

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
  const httpUrl = config.unix
    ? `unix:${config.unix}`
    : `http://${config.host}:${port}`
  const lines = [
    `claude server listening on ${httpUrl}`,
    `auth token: ${authToken}`,
    `auth header: Authorization: Bearer ${authToken}`,
    `connect: claude open ${config.unix ? `cc+unix://${config.unix}` : `cc://${authToken}@${config.host}:${port}`}`,
  ]
  process.stderr.write(`\n${lines.join('\n')}\n\n`)
}
