/**
 * W6 (Q6) — health-mark exposure helpers for the MCP status surfaces.
 *
 * The health-check runtime (services/mcp/healthCheck.ts — ping interval +
 * consecutive-failure threshold, opt-in via CLAUDE_CODE_MCP_HEALTH_CHECK)
 * stores an optional `health` mark on connected servers in AppState; the /mcp
 * status panel mirrors that mark so an unhealthy-but-connected server is
 * visible instead of silently green.
 *
 * Pure predicates — unit-testable without the ink renderer.
 */

type HealthServerView = {
  client: {
    type: string
    health?: { status: 'healthy' | 'unhealthy' }
  }
}

/** True when a connected server carries the health-check unhealthy mark.
 * Non-connected states never report unhealthy (their own status rows cover
 * failed/needs-auth/pending). */
export function isServerHealthUnhealthy(server: HealthServerView): boolean {
  return (
    server.client.type === 'connected' &&
    server.client.health?.status === 'unhealthy'
  )
}

/** True for a connected server without the unhealthy mark (explicitly
 * healthy, or no health mark recorded — the probe is opt-in). */
export function isServerHealthDisplayable(server: HealthServerView): boolean {
  return server.client.type === 'connected' && !isServerHealthUnhealthy(server)
}
