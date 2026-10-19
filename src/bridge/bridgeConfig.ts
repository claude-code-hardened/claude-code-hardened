/**
 * Shared bridge auth/URL resolution. Consolidates the ant-only
 * CLAUDE_BRIDGE_* dev overrides that were previously copy-pasted across
 * a dozen files — inboundAttachments, BriefTool/upload, bridgeMain,
 * initReplBridge, remoteBridgeCore, daemon workers, /rename,
 * /remote-control.
 *
 * Two layers: *Override() returns the ant-only env var (or undefined);
 * the non-Override versions fall through to the real OAuth store/config.
 * Callers that compose with a different auth source (e.g. daemon workers
 * using IPC auth) use the Override getters directly.
 */

import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'

/** Dev override: CLAUDE_BRIDGE_OAUTH_TOKEN, else undefined. */
export function getBridgeTokenOverride(): string | undefined {
  return process.env.CLAUDE_BRIDGE_OAUTH_TOKEN || undefined
}

/** Dev override: CLAUDE_BRIDGE_BASE_URL, else undefined. */
export function getBridgeBaseUrlOverride(): string | undefined {
  return process.env.CLAUDE_BRIDGE_BASE_URL || undefined
}

/**
 * Access token for bridge API calls: dev override first, then the OAuth
 * keychain. Undefined means "not logged in".
 */
export function getBridgeAccessToken(): string | undefined {
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}

/**
 * Base URL for bridge API calls: dev override first, then the production
 * OAuth config. Always returns a URL.
 */
export function getBridgeBaseUrl(): string {
  return getBridgeBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}

/** True when the user has explicitly configured a custom bridge server. */
export function isSelfHostedBridge(): boolean {
  return !!getBridgeBaseUrlOverride()
}

/**
 * Slack tag token (work package W8, task #59, block 4).
 *
 * Official anchor: docs/reverse-284/decompiled 0011-chunk-bxerm1mk
 * /module-003-env-vars.js + 0052-chunk-bxerm1mk/config/env-vars.js —
 * `CLAUDE_CODE_SLACK_TAG_TOKEN` is listed in the official env-var surface
 * alongside the other secret bearer tokens (it also appears in the
 * secret-redaction lists, so it must never be logged or echoed).
 *
 * Read face lives here (notification/bridge env surface): the token tags
 * Slack-side notification fanout for bridge-managed sessions. No consumer
 * ships in this build yet — the getter is the registered export point so
 * a notification bridge can adopt it without redefining the env name.
 * Undefined means "not configured".
 */
export const SLACK_TAG_TOKEN_ENV = 'CLAUDE_CODE_SLACK_TAG_TOKEN'

/**
 * Redaction-list member (official anchor: 0011-chunk-bxerm1mk
 * /module-004-uncategorized.js:1946 — `CLAUDE_CODE_SLACK_TAG_TOKEN`
 * appears in the official secret-redaction env list next to
 * CLAUDE_CODE_OAUTH_TOKEN et al.). Any log/debug/redact pipeline hitting
 * this value must strip it, never echo it.
 */
export function getSlackTagToken(): string | undefined {
  return process.env[SLACK_TAG_TOKEN_ENV] || undefined
}
