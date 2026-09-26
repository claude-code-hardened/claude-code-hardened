import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi'

/**
 * Peer credentials for unix sockets — FFI re-implementation of the
 * Anthropic-bundled Bun's `Bun.ant.getPeerPid/getPeerUid` (native layer
 * surfaces EPEERCRED and logs "[peer-cred] peer pid lookup failed", which
 * pins it to SO_PEERCRED / getpeereid semantics):
 *
 *   linux   getsockopt(fd, SOL_SOCKET, SO_PEERCRED) → struct ucred
 *           { pid: i32, uid: i32, gid: i32 }
 *   darwin  getpeereid(fd, &uid, &gid)
 *   win32   not applicable (upstream K() returns null)
 */

interface PeerCred {
  pid: number
  uid: number
  gid: number
}

type GetPeerCred = (fd: number) => PeerCred | null

let getPeerCredImpl: GetPeerCred | null | undefined

function loadLinux(): GetPeerCred | null {
  try {
    const { symbols } = dlopen('libc.so.6', {
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    })
    const { getsockopt } = symbols
    // SOL_SOCKET=1, SO_PEERCRED=17, struct ucred = 3 × i32
    const ucred = new ArrayBuffer(12)
    const ucredView = new DataView(ucred)
    const lenBuf = new ArrayBuffer(4)
    const lenView = new DataView(lenBuf)
    return fd => {
      lenView.setUint32(0, 12, true)
      const rc = getsockopt(fd, 1, 17, ptr(ucred), ptr(lenBuf)) as number
      if (rc !== 0) return null
      return {
        pid: ucredView.getInt32(0, true),
        uid: ucredView.getInt32(4, true),
        gid: ucredView.getInt32(8, true),
      }
    }
  } catch {
    return null
  }
}

function loadDarwin(): GetPeerCred | null {
  try {
    const { symbols } = dlopen('libSystem.B.dylib', {
      getpeereid: {
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    })
    const { getpeereid } = symbols
    const uidBuf = new ArrayBuffer(4)
    const gidBuf = new ArrayBuffer(4)
    const uidView = new DataView(uidBuf)
    const gidView = new DataView(gidBuf)
    return fd => {
      const rc = getpeereid(fd, ptr(uidBuf), ptr(gidBuf)) as number
      if (rc !== 0) return null
      return {
        pid: 0,
        uid: uidView.getInt32(0, true),
        gid: gidView.getInt32(0, true),
      }
    }
  } catch {
    return null
  }
}

/** Lazy, cached loader; null when the platform has no credential source. */
function getPeerCred(): GetPeerCred | null {
  if (getPeerCredImpl !== undefined) return getPeerCredImpl
  if (process.platform === 'linux') getPeerCredImpl = loadLinux()
  else if (process.platform === 'darwin') getPeerCredImpl = loadDarwin()
  else getPeerCredImpl = null
  return getPeerCredImpl
}

function socketFd(socket: unknown): number {
  const fd = (socket as { _handle?: { fd?: number } } | null)?._handle?.fd
  return typeof fd === 'number' ? fd : -1
}

/**
 * Upstream Bun.ant.getPeerPid: peer pid, null on failure.
 * Prefer the custom-Bun API when running under the Anthropic bundle.
 */
export function getPeerPid(socket: unknown): number | null {
  const bun = globalThis as {
    Bun?: { ant?: { getPeerPid?: (fd: number) => number } }
  }
  if (typeof bun.Bun?.ant?.getPeerPid === 'function') {
    const fd = socketFd(socket)
    if (fd < 0) return null
    try {
      return bun.Bun.ant.getPeerPid(fd)
    } catch {
      return null
    }
  }
  const fd = socketFd(socket)
  if (fd < 0) return null
  return getPeerCred()?.(fd)?.pid ?? null
}

/** Upstream Bun.ant.getPeerUid: peer uid, null on failure/windows. */
export function getPeerUid(socket: unknown): number | null {
  const bun = globalThis as {
    Bun?: { ant?: { getPeerUid?: (fd: number) => number } }
  }
  if (typeof bun.Bun?.ant?.getPeerUid === 'function') {
    const fd = socketFd(socket)
    if (fd < 0) return null
    try {
      return bun.Bun.ant.getPeerUid(fd)
    } catch {
      return null
    }
  }
  if (process.platform === 'win32') return null
  const fd = socketFd(socket)
  if (fd < 0) return null
  return getPeerCred()?.(fd)?.uid ?? null
}

export type { PeerCred, Pointer }
