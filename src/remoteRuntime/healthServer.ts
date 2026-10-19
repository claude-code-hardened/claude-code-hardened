/**
 * Self-hosted runner /healthz listener (work package W8, task #59, block 1).
 *
 * Official anchors (decompiled):
 *   - 0239-chunk-bxerm1mk/module-003-uncategorized.js — self-hosted runner
 *     doctor runbook §7 "Observability gaps":
 *       "/healthz unreachable — Check --health-port; open firewall"
 *       "[runner:warn] /healthz listener failed on port <p>: EADDRINUSE —
 *        Set --health-port to a free port"
 *     and §3 "Pod evicted / restarted by liveness probe — Point probe at
 *     GET :{health-port}/healthz".
 *   - 0376-chunk-zrkp23rq/tools/mcp-dispatch.js — `self_hosted_runner_
 *     read_health` probes `http://127.0.0.1:${health_port}/healthz` and
 *     "0 means disabled" (default port constant, 8080-family).
 *   - Same runbook §9 (:341) — "The endpoint **always returns 200** —
 *     read the body for state." Official orchestrator wording, applied
 *     here to the runner's `--health-port` listener face: every path and
 *     every method answers 200 with the health state in the JSON body
 *     ({ok, path}); the status code is never part of the contract.
 *
 * CCH runner entry face: src/cli/remoteIO.ts constructs RemoteIO for the
 * runner-side session (CCR/bridge worker). At that moment the runner can
 * opt into a localhost-only /healthz HTTP listener via the CLI flag
 * `--health-port[=N]` / `--health-port N` or the env
 * `SELF_HOSTED_RUNNER_HEALTH_PORT` (also accepts
 * CLAUDE_CODE_RUNNER_HEALTH_PORT). Port 0 / unset = disabled (official
 * semantics). One listener per process (module-level singleton); EADDRINUSE
 * degrades to a warn on stderr + continue — the official runbook treats a
 * busy port as an observability gap, not a fatal error. The handle is
 * registered with the cleanup registry so graceful shutdown closes it.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http'

const LOG_PREFIX_WARN = '[runner:warn]'

/** Env vars accepted for the /healthz port (first truthy string wins). */
export const RUNNER_HEALTH_PORT_ENV_VARS = [
  'SELF_HOSTED_RUNNER_HEALTH_PORT',
  'CLAUDE_CODE_RUNNER_HEALTH_PORT',
] as const

/** Default port when --health-port is passed bare (official 8080-family). */
export const RUNNER_HEALTH_PORT_DEFAULT = 8080

export type RunnerHealthzHandle = {
  /** Port the listener actually bound (resolved if port 0 was started directly). */
  port: number
  /** Stop the listener and wait for the socket to release. */
  close: () => Promise<void>
}

function warnHealthz(message: string): void {
  process.stderr.write(`${LOG_PREFIX_WARN} ${message}\n`)
}

function healthzRequestHandler(req: IncomingMessage, res: ServerResponse) {
  // Official semantics (0239 runbook §9, :341): the /healthz endpoint
  // "always returns 200 — read the body for state". Health lives in the
  // body ({ok, path}), never in the status code, on every path and every
  // method — so even a mis-pointed probe gets a diagnosable response.
  const path = req.url?.split('?')[0] ?? ''
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, path }))
}

/**
 * Bind the /healthz HTTP listener on the given port.
 * EADDRINUSE (or any other bind error) degrades to a stderr warn and a
 * null return — the runner keeps serving sessions (runbook §7 semantics).
 */
export async function startRunnerHealthzListener(
  port: number,
): Promise<RunnerHealthzHandle | null> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    warnHealthz(`/healthz disabled — invalid port ${port}`)
    return null
  }

  const server: Server = createServer(healthzRequestHandler)
  server.on('error', err => {
    // Keep the process alive if an unexpected late error lands (e.g. the
    // socket is force-closed by an external supervisor).
    warnHealthz(`/healthz listener error on port ${port}: ${errMsg(err)}`)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } catch (err) {
    if (isErrnoException(err, 'EADDRINUSE')) {
      // Official runbook §7: "[runner:warn] /healthz listener failed on
      // port <p>: EADDRINUSE" — observability gap, not a crash.
      warnHealthz(
        `/healthz listener failed on port ${port}: EADDRINUSE — continuing without /healthz`,
      )
      return null
    }
    warnHealthz(`/healthz listener failed on port ${port}: ${errMsg(err)}`)
    return null
  }

  const boundPort = (server.address() as { port: number }).port
  return {
    port: boundPort,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
        // Avoid holding the event loop open for the close callback.
        server.unref()
      }),
  }
}

/**
 * Resolve the configured /healthz port from argv first, then env.
 * Precedence: `--health-port=N` > `--health-port N` > env.
 * Returns null when disabled (unset/empty/'0'/'false' — official "0 means
 * disabled"). Returns null with a warn on an unparsable value so a typo
 * never binds a random port.
 */
export function resolveRunnerHealthPort(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): number | null {
  let raw: string | undefined
  const flagIndex = argv.findIndex(
    a => a === '--health-port' || a.startsWith('--health-port='),
  )
  if (flagIndex !== -1) {
    const withEq = argv[flagIndex]
    if (withEq?.includes('=')) {
      raw = withEq.slice('--health-port='.length)
    } else {
      raw = argv[flagIndex + 1]
      // Bare flag with no following value -> default 8080 (official runner
      // default; 0 must be passed explicitly to disable).
      if (raw === undefined || raw.startsWith('--')) {
        return RUNNER_HEALTH_PORT_DEFAULT
      }
    }
  } else {
    for (const key of RUNNER_HEALTH_PORT_ENV_VARS) {
      const value = env[key]
      if (value !== undefined && value.trim() !== '') {
        raw = value.trim()
        break
      }
    }
  }

  if (raw === undefined) return null

  if (raw === '0' || raw === 'false' || raw === 'off') return null

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    warnHealthz(`/healthz disabled — unparsable --health-port value '${raw}'`)
    return null
  }
  if (parsed === 0) return null
  return parsed
}

let healthzHandle: Promise<RunnerHealthzHandle | null> | null = null

/**
 * Process-wide entry: resolve the port and start the listener once.
 * Subsequent calls are no-ops (a runner process serves many sessions, but
 * only one /healthz listener may exist). Returns the bound handle, or null
 * when disabled / degraded (EADDRINUSE).
 *
 * Callers gate this behind `feature('BRIDGE_MODE')` at the runner entry
 * (src/cli/remoteIO.ts) and should register `(await h)?.close()` with the
 * cleanup registry so shutdown tears it down.
 */
export function maybeStartRunnerHealthz(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): Promise<RunnerHealthzHandle | null> {
  healthzHandle ??= (async () => {
    const port = resolveRunnerHealthPort(argv, env)
    if (port === null) return null
    return startRunnerHealthzListener(port)
  })()
  return healthzHandle
}

/** Close the singleton listener (shutdown path / tests). */
export function closeRunnerHealthz(): Promise<void> {
  const handle = healthzHandle
  healthzHandle = null
  return handle
    ? handle.then(h => h?.close()).then(() => undefined)
    : Promise.resolve()
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  )
}
