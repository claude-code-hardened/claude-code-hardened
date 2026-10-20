/**
 * URL-building for the server's bind address.
 *
 * Official 2.8.4 evidence (docs/reverse-284/, grep -a): URL / Host
 * reconstruction always brackets a raw IPv6 host before joining `:port` —
 *   decompiled/0011-chunk-bxerm1mk/module-004-uncategorized.js:360 (Xmt):
 *     e.hostname.includes(":") && !e.hostname.startsWith("[")
 *       ? `[${e.hostname}]` : e.hostname, then +(e.port ? `:${e.port}` : "")
 *   decompiled/0006-chunk-j18026mh/module-007-uncategorized.js:4838 (dL):
 *     n.includes(":") ? `[${n}]` : n  →  Host: `${E}:${r}`
 *
 * Without the brackets `--host ::1` produces `http://::1:port`, which no
 * URL parser accepts (A6 audit: the ws:// side had the same defect).
 */

/**
 * Normalize a bind host into the host piece of `http(s)/ws(s)://host:port`.
 * Wildcard/empty binds map to loopback (a wildcard is not dialable from a
 * client) and raw IPv6 literals get bracketed; an already-bracketed host is
 * left untouched so the helper is safe to apply twice.
 */
export const urlHostFor: (host: string | undefined) => string = host => {
  const raw = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
}
