/**
 * Parse a `cc://` / `cc+unix://` direct-connect URL (official chunk-29n3jx8h).
 *
 * Supported shapes:
 *   cc://host:port                      → http://host:port, no token
 *   cc://host:port/sk-ant-cc-xxxx       → token from first path segment
 *   cc://sk-ant-cc-xxxx@host:port       → token from userinfo
 *   cc://sk-ant-si-xxxx@host:port       → session-identity token variant
 *   cc+unix:///path/to/socket.sock      → unix domain socket (RBo: Bun-only)
 *   cc+unix://path/to/socket.sock       → relative unix path accepted too
 *
 * Tokens are only treated as auth when they carry the official
 * `sk-ant-cc-` / `sk-ant-si-` prefixes; bare path segments are left alone.
 *
 * Throws an Error for anything else — consumers rewrite argv based on the
 * result, so a malformed URL must fail loudly, never return empty strings
 * (the empty-object stub was exactly what made generation-3 time out).
 */

/** Official direct-connect token prefixes (chunk-29n3jx8h). */
const TOKEN_PREFIXES = ['sk-ant-cc-', 'sk-ant-si-'] as const

function looksLikeToken(value: string): boolean {
  return TOKEN_PREFIXES.some(prefix => value.startsWith(prefix))
}

/**
 * RBo determination: unix-socket transport requires the Bun runtime
 * (`cc+unix://` URLs are only dialable via Bun's fetch/socket support).
 */
function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

export const parseConnectUrl: (url: string) => {
  serverUrl: string
  authToken: string
  [key: string]: unknown
} = (url: string) => {
  const trimmed = (url ?? '').trim()

  if (trimmed.startsWith('cc+unix://')) {
    let socketPath = trimmed.slice('cc+unix://'.length)
    if (socketPath === '') {
      throw new Error(
        `Invalid connect URL: ${trimmed} — cc+unix:// requires a socket path`,
      )
    }
    // No authority component: '//path' keeps the leading slash, 'path' is
    // relative — normalize both to an absolute-looking path.
    if (!socketPath.startsWith('/')) {
      socketPath = `/${socketPath}`
    }
    if (!isBunRuntime()) {
      throw new Error(
        `Invalid connect URL: ${trimmed} — cc+unix:// requires the Bun runtime (RBo check failed)`,
      )
    }
    // serverUrl stays a placeholder HTTP origin for callers that build
    // `${serverUrl}/sessions`; transport goes through the unix path.
    return {
      serverUrl: 'http://unix',
      authToken: '',
      unix: socketPath,
      isUnix: true,
    }
  }

  if (!trimmed.startsWith('cc://')) {
    throw new Error(
      `Invalid connect URL: ${trimmed} — expected cc://host:port[/token] or cc+unix://socket-path`,
    )
  }

  let rest = trimmed.slice('cc://'.length)
  if (rest === '') {
    throw new Error(`Invalid connect URL: ${trimmed} — missing host`)
  }

  // userinfo form: token@host[:port]
  let authToken = ''
  const atIdx = rest.lastIndexOf('@')
  if (atIdx !== -1) {
    const userInfo = rest.slice(0, atIdx)
    rest = rest.slice(atIdx + 1)
    if (userInfo !== '') {
      if (!looksLikeToken(userInfo)) {
        throw new Error(
          `Invalid connect URL: ${trimmed} — userinfo is not a valid direct-connect token`,
        )
      }
      authToken = userInfo
    }
  }

  if (rest === '') {
    throw new Error(`Invalid connect URL: ${trimmed} — missing host`)
  }

  // Split authority from path. Path may carry the token instead.
  const slashIdx = rest.indexOf('/')
  const authority = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
  const pathPart = slashIdx === -1 ? '' : rest.slice(slashIdx + 1)

  if (authority === '') {
    throw new Error(`Invalid connect URL: ${trimmed} — missing host`)
  }

  if (!authToken && pathPart !== '') {
    const firstSegment = pathPart.split('/')[0] ?? ''
    if (looksLikeToken(firstSegment)) {
      authToken = firstSegment
    }
  }

  return {
    serverUrl: `http://${authority}`,
    authToken,
    isUnix: false,
  }
}
