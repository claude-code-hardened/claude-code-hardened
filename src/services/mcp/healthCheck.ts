// MCP connection liveness probe — "mcp-dispatch health" official semantics,
// anchor docs/reverse-284/decompiled/0376-chunk-zrkp23rq/tools/mcp-dispatch.js:
//   probe with a short fixed timeout ({ timeout: 2000, validateStatus: () => true }),
//   degrade to a structured result instead of throwing
//   ({ disabled, unreachable: true, error }) — never crash the caller.
//
// PORTING DELTA (R6 review, declared honestly): official 0376 does NOT run a
// periodic ping loop — it is a runner-side `GET /healthz` performed on demand
// against the MCP dispatch backend. The periodic surface here (ping()
// interval, consecutive-failure threshold, unhealthy/recover transitions) is
// a CCH extension shaped for the in-session connection manager:
//   - HEALTH_CHECK_INTERVAL_MS (30s) and HEALTH_CHECK_FAILURE_THRESHOLD (3)
//     are CCH-chosen defaults, not official constants;
//   - only the 2s probe timeout ({ timeout: 2000, validateStatus: () => true })
//     and the structured-degrade shape are officially anchored.
// The unhealthy mark is disposed by the connection manager
// (useManageMCPConnections): reconnectable transports get their dead
// connection torn down so the ordinary close→clear-cache→backoff
// reconnection flow takes over.
//
// Opt-in: CLAUDE_CODE_MCP_HEALTH_CHECK=1 (default off).

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import type { MCPServerHealth } from './types.js'

/** mcp-dispatch health anchor default: 2s probe budget. */
export const HEALTH_PROBE_TIMEOUT_MS = 2000
/** Default ping interval (30s). */
export const HEALTH_CHECK_INTERVAL_MS = 30_000
/** Consecutive failed pings before the server is marked unhealthy. */
export const HEALTH_CHECK_FAILURE_THRESHOLD = 3

export const MCP_HEALTH_CHECK_ENV = 'CLAUDE_CODE_MCP_HEALTH_CHECK'

export interface HealthCheckOptions {
  /** Ping interval. Default HEALTH_CHECK_INTERVAL_MS. */
  intervalMs?: number
  /** Per-ping timeout. Default HEALTH_PROBE_TIMEOUT_MS (mcp-dispatch). */
  timeoutMs?: number
  /** Consecutive failures before unhealthy. Default HEALTH_CHECK_FAILURE_THRESHOLD. */
  failureThreshold?: number
  /** Called once when the server transitions healthy → unhealthy. */
  onUnhealthy?: (health: MCPServerHealth) => void
  /** Called once when the server transitions unhealthy → healthy. */
  onRecover?: (health: MCPServerHealth) => void
}

/** One-shot ping with mcp-dispatch timeout semantics (structured result,
 * never throws). Races the SDK ping against a hard local timer so a
 * non-conforming client ping can never wedge the probe loop. */
export async function probeServerHealth(
  client: Client,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<{
  healthy: boolean
  latencyMs?: number
  unreachable?: boolean
  error?: string
}> {
  const start = Date.now()
  try {
    const probe = client.ping({ timeout: timeoutMs })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`health check ping timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      probe.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
    // The losing side of the race must never surface as an unhandled
    // rejection (a ping that settles late is routine).
    probe.catch(() => {})
    return { healthy: true, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      unreachable: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

interface HealthCheckRuntime {
  timer: ReturnType<typeof setInterval>
  client: Client
  options: HealthCheckOptions
  intervalMs: number
  timeoutMs: number
  failureThreshold: number
  failureCount: number
  status: 'healthy' | 'unhealthy'
  lastPingAt?: number
  lastError?: string
}

const runtimes = new Map<string, HealthCheckRuntime>()

/** Opt-in gate for the whole health-check surface. Default off. */
export function isMcpHealthCheckEnabled(): boolean {
  return isEnvTruthy(process.env[MCP_HEALTH_CHECK_ENV]) ? true : false
}

function snapshot(runtime: HealthCheckRuntime): MCPServerHealth {
  return {
    status: runtime.status,
    failureCount: runtime.failureCount,
    ...(runtime.lastPingAt !== undefined && { lastPingAt: runtime.lastPingAt }),
    ...(runtime.lastError !== undefined && { lastError: runtime.lastError }),
  }
}

async function pingOnce(
  name: string,
  runtime: HealthCheckRuntime,
): Promise<void> {
  const result = await probeServerHealth(runtime.client, runtime.timeoutMs)
  runtime.lastPingAt = Date.now()
  if (result.healthy) {
    if (runtime.status === 'unhealthy') {
      runtime.status = 'healthy'
      runtime.failureCount = 0
      runtime.lastError = undefined
      logMCPDebug(name, `Health check recovered (${result.latencyMs}ms ping)`)
      runtime.options.onRecover?.(snapshot(runtime))
      return
    }
    runtime.failureCount = 0
    runtime.lastError = undefined
    return
  }

  runtime.failureCount += 1
  runtime.lastError = result.error
  logMCPDebug(
    name,
    `Health check ping failed (${runtime.failureCount}/${runtime.failureThreshold}): ${result.error ?? 'timeout'}`,
  )
  if (
    runtime.failureCount >= runtime.failureThreshold &&
    runtime.status !== 'unhealthy'
  ) {
    runtime.status = 'unhealthy'
    logMCPError(
      name,
      `MCP server marked unhealthy after ${runtime.failureCount} failed health checks: ${result.error ?? 'timeout'}`,
    )
    runtime.options.onUnhealthy?.(snapshot(runtime))
  }
}

/** Start periodic ping-based liveness probing for a connected server.
 * Returns a stop function; idempotent per server name (restarts replace). */
export function startHealthCheck(
  name: string,
  client: Client,
  options: HealthCheckOptions = {},
): () => void {
  stopHealthCheck(name)
  const intervalMs = options.intervalMs ?? HEALTH_CHECK_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS
  const failureThreshold =
    options.failureThreshold ?? HEALTH_CHECK_FAILURE_THRESHOLD
  const runtime: HealthCheckRuntime = {
    timer: setInterval(() => {
      void pingOnce(name, runtime)
    }, intervalMs),
    client,
    options,
    intervalMs,
    timeoutMs,
    failureThreshold,
    failureCount: 0,
    status: 'healthy',
  }
  // Never keep the event loop alive just for health pings.
  runtime.timer.unref?.()
  runtimes.set(name, runtime)
  return () => stopHealthCheck(name)
}

/** Stop probing a server (idempotent). */
export function stopHealthCheck(name: string): void {
  const runtime = runtimes.get(name)
  if (!runtime) return
  clearInterval(runtime.timer)
  runtimes.delete(name)
}

/** Latest health mark for a server, if probed. */
export function getServerHealth(name: string): MCPServerHealth | undefined {
  const runtime = runtimes.get(name)
  return runtime ? snapshot(runtime) : undefined
}

/** Stop all probes (session teardown / hook unmount). */
export function stopAllHealthChecks(): void {
  for (const name of [...runtimes.keys()]) {
    stopHealthCheck(name)
  }
}
