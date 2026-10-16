import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  handleControlRequest,
  resetControlRateLimiterForTests,
  type ControlServerDeps,
  type JobHandle,
} from '../controlServer.js'
import type { Socket } from 'net'
import type { ControlRequest, ControlResponse } from '../controlProtocol.js'

// 层 1（官方语义）要求 SO_PEERCRED 可用：peerUid 精确比对 daemon uid 后才走
// 明文 control key 校验（本文件的用例即按该 wire contract 编写）。真实
// 实现经 peerCredentials（FFI SO_PEERCRED）；fakeSocket 不是真 socket，任何
// 环境下都拿不到内核凭证，于是 handleControlRequest 会退化到层 2
// （challenge-response HMAC）并全数拒绝明文 key 用例——CI 上表现为首轮
// EAUTH、随后全局限速器锁定（ERATE）。这里在进程内临时提供
// Bun.ant.getPeerUid（peerCredentials 的首选路径），让同 uid 假套接字模拟
// "标准环境"，文件结束后立即移除，不泄漏给其他测试文件。
beforeAll(() => {
  const bun = Bun as unknown as {
    ant?: { getPeerUid?: (fd: number) => number }
  }
  try {
    previousAnt = bun.ant
    bun.ant = {
      ...previousAnt,
      getPeerUid: (_fd: number) => process.getuid?.() ?? 0,
    }
    antStubbed = true
  } catch {
    // Bun 全局不可扩展时保持原状——用例会退化为层 2（与补充前一致）。
    antStubbed = false
  }
})

let previousAnt: { getPeerUid?: (fd: number) => number } | undefined
let antStubbed = false

afterAll(() => {
  if (antStubbed) {
    ;(Bun as unknown as { ant?: unknown }).ant = previousAnt
  }
})

/** 收集 sendReply 输出的假 socket（destroyed/end 语义同真 socket）。 */
function fakeSocket(): Socket & { replies: ControlResponse[] } {
  const replies: ControlResponse[] = []
  return {
    replies,
    destroyed: false,
    readableEnded: false,
    // controlProtocol.getPeerUid 先读 _handle.fd；正数 fd + 上面的
    // Bun.ant.getPeerUid 桩 = 与 daemon 同 uid 的模拟本地套接字。
    _handle: { fd: 4242 },
    end: (s: string) => {
      replies.push(JSON.parse(s.replace(/\n$/, '')) as ControlResponse)
    },
  } as never
}

function makeDeps(
  overrides: Partial<ControlServerDeps> = {},
): ControlServerDeps {
  return {
    handles: new Map<string, JobHandle>(),
    settled: new Map<string, { nonce?: string; refusal?: string }>(),
    onDispatch: async d => ({ dispatched: true, short: d['short'] }),
    onNudge: () => {},
    onShutdown: () => {},
    whenReady: Promise.resolve(),
    controlKey: 'server-key-123',
    addLease: () => {},
    removeLease: () => {},
    log: () => {},
    telemetry: () => {},
    ...overrides,
  }
}

function makeJob(short: string, overrides: Partial<JobHandle> = {}): JobHandle {
  return {
    record: { short, pid: 4242, messagingSock: '/tmp/msg.sock' },
    dispatch: { launch: { mode: 'worker' } },
    attachers: new Map(),
    respawnIfIdleStale: async () => ({ respawned: true }),
    alive: () => true,
    ...overrides,
  }
}

describe('handleControlRequest (upstream yn)', () => {
  beforeEach(() => {
    // 限速单例跨测试共享失败计数：本文件前序用例（EAUTH 等）的 recordFailure
    // 会耗尽滑窗预算，尾部两例收到 ERATE / 走不到 shutdown。每个用例重置。
    resetControlRateLimiterForTests()
  })

  test('bad json shape → EUNKNOWN', async () => {
    const socket = fakeSocket()
    await handleControlRequest(makeDeps(), socket, null as never)
    expect(socket.replies[0]).toEqual({
      ok: false,
      error: 'bad json',
      code: 'EUNKNOWN',
    })
  })

  test('ping → ok with version.ISSUES_EXPLAINER', async () => {
    const socket = fakeSocket()
    await handleControlRequest(makeDeps(), socket, { op: 'ping' })
    expect(socket.replies[0]!.ok).toBe(true)
    expect(
      (socket.replies[0] as { version?: { ISSUES_EXPLAINER?: string } }).version
        ?.ISSUES_EXPLAINER,
    ).toContain('claude-code-hardened')
  })

  test('list marks dying jobs', async () => {
    const deps = makeDeps()
    deps.handles.set('aaaaaaaa', makeJob('aaaaaaaa', { isKilling: true }))
    const socket = fakeSocket()
    await handleControlRequest(deps, socket, { op: 'list' })
    const resp = socket.replies[0] as unknown as {
      jobs: Array<{ short: string; dying?: boolean }>
    }
    expect(resp.jobs).toHaveLength(1)
    expect(resp.jobs[0]!.dying).toBe(true)
  })

  test('has reflects alive/present/ready', async () => {
    const deps = makeDeps()
    deps.handles.set('aaaaaaaa', makeJob('aaaaaaaa'))
    const socket = fakeSocket()
    await handleControlRequest(deps, socket, { op: 'has', short: 'aaaaaaaa' })
    expect(socket.replies[0]).toEqual({
      ok: true,
      op: 'has',
      alive: true,
      present: true,
      ready: true,
    })
  })

  test('dispatch without auth → EAUTH with official text', async () => {
    const socket = fakeSocket()
    await handleControlRequest(makeDeps(), socket, {
      op: 'dispatch',
      d: { short: 'aaaaaaaa' },
    })
    const resp = socket.replies[0]!
    expect(resp.code).toBe('EAUTH')
    expect(resp.error).toContain("didn't present the daemon control key")
  })

  test('dispatch with correct auth proceeds (cold-settled → via:cold)', async () => {
    const deps = makeDeps()
    deps.settled.set('aaaaaaaa', { nonce: 'n1' })
    const socket = fakeSocket()
    await handleControlRequest(deps, socket, {
      op: 'dispatch',
      auth: 'server-key-123',
      timeoutMs: 80,
      d: { short: 'aaaaaaaa', nonce: 'n1' },
    })
    expect(socket.replies[0]).toEqual({
      ok: true,
      op: 'dispatch',
      short: 'aaaaaaaa',
      pid: 0,
      messagingSock: '',
      via: 'cold',
    })
  })

  test('settled with refusal → ECWDGONE', async () => {
    const deps = makeDeps()
    deps.settled.set('aaaaaaaa', { nonce: 'n1', refusal: 'cwd removed' })
    const socket = fakeSocket()
    await handleControlRequest(deps, socket, {
      op: 'dispatch',
      auth: 'server-key-123',
      timeoutMs: 80,
      d: { short: 'aaaaaaaa', nonce: 'n1' },
    })
    expect(socket.replies[0]).toEqual({
      ok: false,
      error: 'cwd removed',
      code: 'ECWDGONE',
    })
  })

  test('reply without auth → old-client hint text', async () => {
    const socket = fakeSocket()
    await handleControlRequest(makeDeps(), socket, { op: 'reply' })
    expect(socket.replies[0]!.error).toContain('older than the daemon')
  })

  test('attach legacy client (auth undefined) → allowed via peerUid', async () => {
    const logs: string[] = []
    const deps = makeDeps({ log: l => logs.push(l) })
    const socket = fakeSocket()
    await handleControlRequest(deps, socket, { op: 'attach' })
    expect(socket.replies[0]!.ok).toBe(true)
    expect(logs.some(l => l.includes('legacy client'))).toBe(true)
  })

  test('attach with wrong key → EAUTH', async () => {
    const socket = fakeSocket()
    await handleControlRequest(makeDeps(), socket, {
      op: 'attach',
      auth: 'wrong',
    })
    expect(socket.replies[0]!.code).toBe('EAUTH')
  })

  test('kill unknown short → ENOJOB', async () => {
    const socket = fakeSocket()
    await handleControlRequest(makeDeps(), socket, {
      op: 'kill',
      short: 'aaaaaaaa',
    })
    expect(socket.replies[0]!.code).toBe('ENOJOB')
  })

  test('kill exec-mode job with outcome deletes immediately', async () => {
    const deps = makeDeps()
    deps.handles.set(
      'aaaaaaaa',
      makeJob('aaaaaaaa', {
        dispatch: { launch: { mode: 'exec' } },
        record: { short: 'aaaaaaaa', pid: 1, outcome: 'success' },
      }),
    )
    const socket = fakeSocket()
    await handleControlRequest(deps, socket, { op: 'kill', short: 'aaaaaaaa' })
    expect(socket.replies[0]!.ok).toBe(true)
    expect(deps.handles.has('aaaaaaaa')).toBe(false)
  })

  test('bad short id → EPROTO', async () => {
    const socket = fakeSocket()
    await handleControlRequest(makeDeps(), socket, {
      op: 'kill',
      short: 'NOPE',
    })
    expect(socket.replies[0]!.code).toBe('EPROTO')
  })

  test('shutdown triggers onShutdown', async () => {
    let called = false
    const deps = makeDeps({
      onShutdown: () => {
        called = true
      },
    })
    const socket = fakeSocket()
    await handleControlRequest(deps, socket, { op: 'shutdown' })
    expect(called).toBe(true)
  })
})
