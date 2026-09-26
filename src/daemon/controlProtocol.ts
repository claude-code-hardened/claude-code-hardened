import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { Socket } from 'net'

/**
 * Control socket protocol — 1:1 port of the official claude daemon
 * (v2.1.283) wire contract:
 *
 *   transport   unix socket /tmp/cc-daemon-<uid>/<hash8>/control.sock
 *               (Windows: named pipe \\.\pipe\cch-daemon-<id>-<e>)
 *   framing     newline-delimited JSON; server replies JSON + '\n'
 *   request     { op, short?, nonce?, timeoutMs?, auth?, d? }
 *   response    { ok, op?, code?, error?, ... }
 *   auth        ① peer uid check (EPEERUID) ② control key (EAUTH) for
 *               dispatch/reply/permission-response; attach without auth is
 *               a legacy client — allowed via peerUid
 */

export type EErrorCode =
  | 'EAUTH'
  | 'ECWDGONE'
  | 'EHOSTDEAD'
  | 'ENOJOB'
  | 'ENOREPLY'
  | 'EPEERUID'
  | 'EPROTO'
  | 'ERESPAWNING'
  | 'ESTALE'
  | 'ESTARTING'
  | 'ETIMEOUT'
  | 'ETOOLARGE'
  | 'EUNKNOWN'
  | 'EUNVERIFIED'

/** Official code set, kept exhaustive so protocol drift is a type error. */
export const ERROR_CODES: readonly EErrorCode[] = [
  'EAUTH',
  'ECWDGONE',
  'EHOSTDEAD',
  'ENOJOB',
  'ENOREPLY',
  'EPEERUID',
  'EPROTO',
  'ERESPAWNING',
  'ESTALE',
  'ESTARTING',
  'ETIMEOUT',
  'ETOOLARGE',
  'EUNKNOWN',
  'EUNVERIFIED',
]

export type ControlOp =
  | 'ping'
  | 'attach'
  | 'dispatch'
  | 'reply'
  | 'nudge'
  | 'kill'
  | 'resize'
  | 'lease'
  | 'leases'
  | 'list'
  | 'has'
  | 'await-ack'
  | 'ensure-spare'
  | 'permission-response'
  | 'shutdown'
  | 'yield'
  | 'respawn-stale'

export interface ControlRequest {
  op: ControlOp
  short?: string
  nonce?: string
  timeoutMs?: number
  auth?: string
  cols?: number
  rows?: number
  attachId?: string
  evict?: boolean
  d?: Record<string, unknown>
  [k: string]: unknown
}

export interface ControlResponse {
  ok: boolean
  op?: string
  code?: EErrorCode
  error?: string
  [k: string]: unknown
}

/** Session root: the dir the daemon supervises; hash input is its resolve. */
export function sessionRootHash(root: string): string {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 8)
}

/** /tmp/cch-daemon-<uid>/<hash8> — TERMUX PREFIX /tmp honored like upstream. */
export function daemonSockDir(root: string): string {
  const uid = process.getuid?.() ?? 0
  const termuxPrefix = process.env['TERMUX_VERSION'] && process.env['PREFIX']
  const base = termuxPrefix ? join(termuxPrefix, 'tmp') : tmpdir()
  return join(base, `cch-daemon-${uid}`, sessionRootHash(root))
}

export function controlSockPath(root: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cch-daemon-${sessionRootHash(root)}-${process.getuid?.() ?? 0}`
  }
  return join(daemonSockDir(root), 'control.sock')
}

/** ~/.cch/daemon/control.key — mirror upstream's ~/.claude/daemon/control.key. */
export function controlKeyPath(): string {
  return join(homedir(), '.cch', 'daemon', 'control.key')
}

/** Read the control key (≤4096 bytes guard, trimmed), null when absent. */
export function readControlKey(): string | null {
  const p = controlKeyPath()
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size > 4096) return null
    const key = readFileSync(p, 'utf8').trim()
    return key.length > 0 ? key : null
  } catch {
    return null
  }
}

/** Generate and persist a fresh control key with 0600; returns the key. */
export function ensureControlKey(): string {
  const p = controlKeyPath()
  const existing = readControlKey()
  if (existing) return existing
  const key = randomBytes(32).toString('hex')
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, key, { mode: 0o600 })
  return key
}

/**
 * Upstream vD: constant-time comparison; empty/short-circuit rejected first,
 * length mismatch rejected before compare (timingSafeEqual throws otherwise).
 */
export function verifyControlKey(
  presented: unknown,
  serverKey: string | null,
): boolean {
  if (typeof presented !== 'string' || !serverKey || presented.length === 0)
    return false
  const a = Buffer.from(presented)
  const b = Buffer.from(serverKey)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Upstream T: single JSON line reply. Destroyed sockets are a no-op.
 */
export function sendReply(socket: Socket, resp: ControlResponse): void {
  if (socket.destroyed) return
  socket.end(JSON.stringify(resp) + '\n')
}

/** Upstream RTo message text, kept verbatim for wire compatibility. */
export function peerUidMismatchError(
  connectingUid: number,
  daemonUid: number,
): string {
  return `permission denied: connecting uid ${connectingUid} != daemon uid ${daemonUid} (retry without sudo, or as the daemon owner)`
}

/**
 * Peer uid via Bun.ant.getPeerUid when available (Anthropic-bundled Bun).
 * Standard Bun/Node lack it — returns null (check skipped, key auth still
 * applies). Matches upstream's K(): windows → null, fd < 0 → null,
 * lookup failure → null + warn.
 */
export function getPeerUid(socket: Socket): number | null {
  if (process.platform === 'win32') return null
  const bun = globalThis as {
    Bun?: { ant?: { getPeerUid?: (fd: number) => number } }
  }
  const getPeerUidFn = bun.Bun?.ant?.getPeerUid
  if (!getPeerUidFn) return null
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd
  if (typeof fd !== 'number' || fd < 0) return null
  try {
    return getPeerUidFn(fd)
  } catch (err) {
    console.warn(
      `[daemon] peer uid lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Upstream RTo: null = allow; string = reject reason.
 * Skipped when the platform has no getuid or no peer credential source.
 */
export function peerUidReject(
  socket: Socket,
  peerUidReader: (s: Socket) => number | null = getPeerUid,
): string | null {
  const daemonUid = process.getuid?.()
  if (daemonUid == null) return null
  const peer = peerUidReader(socket)
  if (peer == null) return null
  if (peer === daemonUid) return null
  console.error(
    `[daemon] rejecting control connection: ${peerUidMismatchError(peer, daemonUid)}`,
  )
  return peerUidMismatchError(peer, daemonUid)
}

/**
 * Redact socket dir identifiers from error text before logging (upstream
 * hw() covers the Windows pipe's 16-hex; we additionally cover the Linux
 * layout <uid>/<hash8> so both namespaces collapse to cch-daemon-*).
 */
export function redactSockPath(text: string): string {
  return text
    .replace(/cch-daemon-\d+\/[0-9a-f]{8}/g, 'cch-daemon-*')
    .replace(/cch-daemon-[0-9a-f]{16}/g, 'cch-daemon-*')
}

export function isValidShortId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-f0-9]{8}$/.test(id)
}

export { existsSync, isAbsolute }
