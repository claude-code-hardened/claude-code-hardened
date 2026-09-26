/**
 * Managed Agents platform API client — /v1/sessions, /v1/environments,
 * /v1/deployments (scheduled deployments) under the managed-agents beta.
 *
 * Endpoint semantics from the official platform docs (managed-agents-core /
 * scheduled-deployments): agent creation is a prerequisite for sessions;
 * sessions reference agent + environment by ID and produce an event stream;
 * deployments bundle agent + environment + initial_events + cron schedule.
 *
 * Auth model matches agentsApi.ts: workspace-scoped API key (sk-ant-api03-*)
 * + managed-agents beta header. Subscription OAuth tokens 401 here by design.
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { assertWorkspaceHost } from '../../services/auth/hostGuard.js'
import { prepareWorkspaceApiRequest } from '../../utils/teleport/api.js'

const AGENTS_BETA_HEADER = 'managed-agents-2026-04-01'
const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class ManagedAgentsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'ManagedAgentsError'
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  const prepared = await prepareWorkspaceApiRequest()
  const host = getOauthConfig().BASE_API_URL
  assertWorkspaceHost(host)
  return {
    Authorization: `Bearer ${prepared.apiKey}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': AGENTS_BETA_HEADER,
    'content-type': 'application/json',
  }
}

function platformBaseUrl(): string {
  const base = getOauthConfig().BASE_API_URL
  return `${base.replace(/\/$/, '')}/v1`
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastError = err
      if (!axios.isAxiosError(err)) throw err
      const status = err.response?.status ?? 0
      if (status < 500 && status !== 429) throw err
      if (attempt < MAX_RETRIES - 1) {
        const ra = err.response?.headers?.['retry-after']
        const waitMs = ra ? Number(ra) * 1000 : 2 ** attempt * 1000
        await sleep(waitMs)
      }
    }
  }
  throw lastError
}

// ── Events ──

export type SessionEventType =
  | 'user.message'
  | 'user.tool_result'
  | 'user.tool_confirmation'
  | 'user.custom_tool_result'
  | 'user.interrupt'
  | 'user.define_outcome'
  | 'system.message'

export interface SessionEvent {
  type: SessionEventType
  content?: Array<{ type: string; text?: string }>
  [k: string]: unknown
}

/** Events that resolve in-flight work; accepted even at budget pause. */
export const SETTLE_EVENTS: readonly SessionEventType[] = [
  'user.tool_confirmation',
  'user.tool_result',
  'user.custom_tool_result',
  'user.interrupt',
]

// ── Sessions ──

export type SessionStatus = 'idle' | 'running' | 'rescheduling' | 'terminated'

export interface ManagedSession {
  id: string
  title?: string
  status: SessionStatus
  stop_reason?: string
  created_at?: string
  [k: string]: unknown
}

export interface CreateSessionInput {
  /** pre-created agent id (required — model/prompt live on the agent) */
  agent: string
  environment_id: string
  initial_events: SessionEvent[]
  title?: string
  vault_ids?: string[]
  budget?: { max_tokens?: number; [k: string]: unknown }
  [k: string]: unknown
}

export async function listSessions(): Promise<ManagedSession[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<{ data: ManagedSession[] }>(
      `${platformBaseUrl()}/sessions`,
      { headers },
    )
    return response.data.data ?? []
  })
}

export async function createSession(
  input: CreateSessionInput,
): Promise<ManagedSession> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<ManagedSession>(
      `${platformBaseUrl()}/sessions`,
      input,
      { headers },
    )
    return response.data
  })
}

export async function getSession(id: string): Promise<ManagedSession> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<ManagedSession>(
      `${platformBaseUrl()}/sessions/${id}`,
      { headers },
    )
    return response.data
  })
}

/** Session becomes read-only; not reversible. */
export async function archiveSession(id: string): Promise<void> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    await axios.post(
      `${platformBaseUrl()}/sessions/${id}/archive`,
      {},
      { headers },
    )
  })
}

/** Permanently deletes session, event history, container, checkpoints. */
export async function deleteSession(id: string): Promise<void> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    await axios.delete(`${platformBaseUrl()}/sessions/${id}`, { headers })
  })
}

/** Fetch the event stream (paged). */
export async function listSessionEvents(
  id: string,
  after?: string,
): Promise<{ data: Array<Record<string, unknown>>; next?: string }> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get(
      `${platformBaseUrl()}/sessions/${id}/events`,
      { headers, params: after ? { after } : undefined },
    )
    return response.data
  })
}

// ── Environments ──

export interface ManagedEnvironment {
  id: string
  name: string
  kind?: 'cloud' | 'self-hosted'
  [k: string]: unknown
}

export async function listEnvironments(): Promise<ManagedEnvironment[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<{ data: ManagedEnvironment[] }>(
      `${platformBaseUrl()}/environments`,
      { headers },
    )
    return response.data.data ?? []
  })
}

export async function createEnvironment(
  input: Record<string, unknown>,
): Promise<ManagedEnvironment> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<ManagedEnvironment>(
      `${platformBaseUrl()}/environments`,
      input,
      { headers },
    )
    return response.data
  })
}

// ── Scheduled deployments ──

export interface ScheduledDeployment {
  id: string
  name: string
  agent: string
  environment_id: string
  schedule: {
    type: 'cron'
    expression: string
    timezone: string
    [k: string]: unknown
  }
  initial_events: SessionEvent[]
  [k: string]: unknown
}

export async function listDeployments(): Promise<ScheduledDeployment[]> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.get<{ data: ScheduledDeployment[] }>(
      `${platformBaseUrl()}/deployments`,
      { headers },
    )
    return response.data.data ?? []
  })
}

/**
 * Create a recurring deployment: agent + environment + initial_events
 * (must contain at least one user.message or user.define_outcome) +
 * cron schedule. Self-hosted environments support memory_store resources;
 * file/github_repository resources require a cloud environment.
 */
export async function createDeployment(
  input: Omit<ScheduledDeployment, 'id'>,
): Promise<ScheduledDeployment> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    const response = await axios.post<ScheduledDeployment>(
      `${platformBaseUrl()}/deployments`,
      input,
      { headers },
    )
    return response.data
  })
}

export async function deleteDeployment(id: string): Promise<void> {
  return withRetry(async () => {
    const headers = await buildHeaders()
    await axios.delete(`${platformBaseUrl()}/deployments/${id}`, { headers })
  })
}

/** Console trace URL for a session (workspace-scoped; not workspace-agnostic). */
export function sessionTraceUrl(
  sessionId: string,
  workspaceId = 'default',
): string {
  return `https://platform.claude.com/workspaces/${workspaceId}/sessions/${sessionId}`
}
