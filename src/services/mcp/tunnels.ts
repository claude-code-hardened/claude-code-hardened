// MCP tunnels — cloud API client (PARTIAL SUBSET of the official surface).
// Official anchors (docs/reverse-284/decompiled/0032-chunk-dyqmyxqn):
//   model-provider/anthropic.js:60,62 — every /v1/tunnels* call injects the
//     version header `anthropic-beta: mcp-tunnels-2026-06-22` alongside
//     per-call betas:
//       POST /v1/tunnels?beta=true                                 (create)
//       GET  /v1/tunnels/{id}?beta=true                            (retrieve)
//       POST /v1/tunnels/{id}/certificates?beta=true               (certificates.create)
//       GET  /v1/tunnels/{tunnel_id}/certificates/{id}?beta=true   (certificates.retrieve)
//   module-004-api-endpoints.js:24-25 — /v1/tunnels route family.
//
// MISSING OPERATIONS (R6 review — declared; official `yt`/`_r` client has
// them, this subset does not — implement before relying on the gate being ON):
//   - POST /v1/tunnels/{id}/archive?beta=true                  (tunnels.archive)
//   - POST /v1/tunnels/{id}/reveal_token?beta=true             (tunnels.revealToken)
//   - POST /v1/tunnels/{id}/rotate_token?beta=true             (tunnels.rotateToken)
//   - GET  /v1/tunnels/{tunnel_id}/certificates?beta=true      (certificates.list)
//   - POST /v1/tunnels/{tunnel_id}/certificates/{id}/archive?beta=true
//     (certificates.archive — 0032 class `_r.archive`: the nested route still
//     sends `?beta=true`, verbatim `/certificates/${id}/archive?beta=true`)
// The `certificates` resource is nested under a tunnel, per the official
// client (`this.certificates = new _r(this._client)`).
// Cloud dependency: feature-gated by MCP_TUNNELS (build defaults leave it
// OFF; enable via FEATURE_MCP_TUNNELS=1). Types + client compile standalone;
// nothing in the session wiring calls them until the gate is on.

import { feature } from 'bun:bundle'
import { getOauthConfig } from '../../constants/oauth.js'

export const MCP_TUNNELS_BETA_HEADER = 'mcp-tunnels-2026-06-22'

// ---------------------------------------------------------------------------
// Resource types (typed for the implemented subset — NOT the complete
// official surface; see MISSING OPERATIONS in the file header)
// ---------------------------------------------------------------------------

export type TunnelStatus = 'pending' | 'active' | 'disconnected' | 'closed'

export interface Tunnel {
  id: string
  object: 'tunnel'
  /** Human-readable label for the tunnel. */
  name?: string
  status: TunnelStatus
  /** Server-assigned connect URL (ws(s)://) for MCP traffic. */
  url?: string
  created_at?: string
  updated_at?: string
}

export interface TunnelCertificate {
  id: string
  object: 'tunnel_certificate'
  /** Tunnel this certificate is scoped to. */
  tunnel_id: string
  /** PEM-encoded client certificate (mTLS material for the tunnel). */
  certificate?: string
  expires_at?: string
  created_at?: string
}

export interface ListTunnelsResponse {
  data: Tunnel[]
  has_more?: boolean
}

export interface CreateTunnelParams {
  name?: string
  /** Requested validity window (seconds) — server may clamp. */
  ttl_seconds?: number
  metadata?: Record<string, string>
}

export interface CreateTunnelCertificateParams {
  tunnel_id: string
  /** PEM CSR — server-signed certificate when provided. */
  csr?: string
  ttl_seconds?: number
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TunnelsClientOptions {
  /** API base, e.g. https://api.anthropic.com. Defaults to the configured
   * first-party BASE_API_URL (honors staging/local overrides). */
  baseUrl?: string
  /** Bearer credential. Defaults to the OAuth access token when available. */
  accessToken?: string
  /** Injectable fetch for tests / proxies. */
  fetchFn?: typeof fetch
  /** Extra per-call betas merged into the anthropic-beta header. */
  betas?: string[]
}

export class McpTunnelsDisabledError extends Error {
  constructor() {
    super('MCP tunnels feature is disabled (enable with FEATURE_MCP_TUNNELS=1)')
    this.name = 'McpTunnelsDisabledError'
  }
}

/** Feature gate — MCP_TUNNELS is not in DEFAULT_BUILD_FEATURES, so the
 * cloud dependency stays off unless explicitly enabled. */
export function isMcpTunnelsEnabled(): boolean {
  return feature('MCP_TUNNELS') ? true : false
}

/** Build request headers with the mcp-tunnels version header (0032 anchor
 * `u([{"anthropic-beta":[...betas??[],"mcp-tunnels-2026-06-22"].toString()},
 * extra?.headers])` — the merged anthropic-beta value feeds the same header
 * slot that `extra` (per-call headers) may override wholesale, mirroring the
 * official second-element override). */
export function buildTunnelsHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    // Version header first so it survives per-call beta merging.
    'anthropic-beta': MCP_TUNNELS_BETA_HEADER,
    ...extra,
  }
}

/** Resolve the tunnels base URL: explicit option > first-party configured API base. */
export function getTunnelsBaseUrl(explicit?: string): string {
  if (explicit) return explicit.replace(/\/$/, '')
  return getOauthConfig().BASE_API_URL.replace(/\/$/, '')
}

/** Official beta merge (0032-chunk-dyqmyxqn model-provider/anthropic.js,
 * every tunnels route verbatim):
 *   `{"anthropic-beta": [...perCallBetas ?? [], "mcp-tunnels-2026-06-22"].toString()}`
 * — per-call betas come FIRST, the tunnels version header is appended last.
 * Exported for the merge-order test (the gate itself is not runtime-flippable
 * under bun:bundle defines). */
export function withBetas(betas?: string[]): Record<string, string> {
  return betas && betas.length > 0
    ? { 'anthropic-beta': [...betas, MCP_TUNNELS_BETA_HEADER].join(',') }
    : {}
}

/** Partial tunnels API client (subset of the official nested surface):
 * client.list() / client.create() / client.retrieve() / client.certificates
 * {create,retrieve}. Missing ops are declared in the file header. */
export function createTunnelsClient(options: TunnelsClientOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch
  const betas = options.betas
  const base = () => getTunnelsBaseUrl(options.baseUrl)

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!isMcpTunnelsEnabled()) throw new McpTunnelsDisabledError()
    const url = `${base()}${path}`
    const response = await fetchFn(url, {
      method,
      headers: {
        ...buildTunnelsHeaders(withBetas(betas)),
        ...(options.accessToken
          ? { authorization: `Bearer ${options.accessToken}` }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) {
      throw new Error(
        `MCP tunnels request failed: ${method} ${path} → ${response.status}`,
      )
    }
    return (await response.json()) as T
  }

  const client = {
    /** GET /v1/tunnels — list tunnels. */
    async list(): Promise<ListTunnelsResponse> {
      return request<ListTunnelsResponse>('GET', '/v1/tunnels?beta=true')
    },
    /** POST /v1/tunnels — create a tunnel. */
    async create(params: CreateTunnelParams): Promise<Tunnel> {
      return request<Tunnel>('POST', '/v1/tunnels?beta=true', params)
    },
    /** GET /v1/tunnels/{id} — retrieve a tunnel. */
    async retrieve(tunnelId: string): Promise<Tunnel> {
      return request<Tunnel>(
        'GET',
        `/v1/tunnels/${encodeURIComponent(tunnelId)}?beta=true`,
      )
    },
    /** Nested certificates resource (official: this.certificates). */
    certificates: {
      /** POST /v1/tunnels/{tunnel_id}/certificates */
      async create(
        params: CreateTunnelCertificateParams,
      ): Promise<TunnelCertificate> {
        const { tunnel_id: tunnelId, ...body } = params
        return request<TunnelCertificate>(
          'POST',
          `/v1/tunnels/${encodeURIComponent(tunnelId)}/certificates?beta=true`,
          body,
        )
      },
      /** GET /v1/tunnels/{tunnel_id}/certificates/{id} */
      async retrieve(
        tunnelId: string,
        certificateId: string,
      ): Promise<TunnelCertificate> {
        return request<TunnelCertificate>(
          'GET',
          `/v1/tunnels/${encodeURIComponent(tunnelId)}/certificates/${encodeURIComponent(certificateId)}?beta=true`,
        )
      },
    },
  }
  return client
}

export type TunnelsClient = ReturnType<typeof createTunnelsClient>
