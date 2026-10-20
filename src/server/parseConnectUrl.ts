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

function countColons(value: string): number {
  return (value.match(/:/g) ?? []).length
}

/**
 * Bracket tolerance for the cc:// authority (A6 follow-up): the canonical
 * IPv6 input is pre-bracketed (`cc://[::1]:8080`) and passes through
 * unchanged, but an unbracketed literal is also normalized so the built
 * origin stays parsable — official URL reconstruction does the same
 * (2.8.4, decompiled/0011-chunk-bxerm1mk/module-004-uncategorized.js:360
 * Xmt: hostname containing ":" and not already bracketed is wrapped).
 *
 * Conventions for the inherently-ambiguous unbracketed form:
 *   colonCount 0        → plain hostname, unchanged
 *   colonCount 1        → host:port, unchanged (plain hostname case)
 *   colonCount ≥ 2      → unbracketed IPv6: bracket the whole authority,
 *                         except when the tail after the LAST colon is a
 *                         decimal port (≤5 digits) AND the remaining host
 *                         still keeps ≥2 colons — then only the host part
 *                         is bracketed ("::1:8080" → "[::1]:8080" is host
 *                         ::1 port 8080; bare "::1" stays address-only).
 * Bracketed form is recommended; users should write cc://[::1]:8080.
 */
function normalizeAuthority(authority: string): string {
  const colons = countColons(authority)
  if (colons === 0 || authority.startsWith('[') || colons === 1) {
    return authority
  }
  const lastColon = authority.lastIndexOf(':')
  const tail = authority.slice(lastColon + 1)
  const host = authority.slice(0, lastColon)
  if (/^\d{1,5}$/.test(tail) && countColons(host) >= 2) {
    return `[${host}]:${tail}`
  }
  return `[${authority}]`
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
    serverUrl: `http://${normalizeAuthority(authority)}`,
    authToken,
    isUnix: false,
  }
}
