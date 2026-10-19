/**
 * Sandbox types for the Claude Code Agent SDK
 *
 * This file is the single source of truth for sandbox configuration types.
 * Both the SDK and the settings validation import from here.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * Network configuration schema for sandbox.
 */
export const SandboxNetworkConfigSchema = lazySchema(() =>
  z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      allowManagedDomainsOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), only allowedDomains and WebFetch(domain:...) allow rules from managed settings are respected. ' +
            'User, project, local, and flag settings domains are ignored. Denied domains are still respected from all sources.',
        ),
      allowUnixSockets: z
        .array(z.string())
        .optional()
        .describe(
          'macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path).',
        ),
      allowAllUnixSockets: z
        .boolean()
        .optional()
        .describe(
          'If true, allow all Unix sockets (disables blocking on both platforms).',
        ),
      allowLocalBinding: z.boolean().optional(),
      httpProxyPort: z.number().optional(),
      socksProxyPort: z.number().optional(),
    })
    .optional(),
)

/**
 * Filesystem configuration schema for sandbox.
 */
export const SandboxFilesystemConfigSchema = lazySchema(() =>
  z
    .object({
      allowWrite: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to allow writing within the sandbox. ' +
            'Merged with paths from Edit(...) allow permission rules.',
        ),
      denyWrite: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to deny writing within the sandbox. ' +
            'Merged with paths from Edit(...) deny permission rules.',
        ),
      denyRead: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to deny reading within the sandbox. ' +
            'Merged with paths from Read(...) deny permission rules.',
        ),
      allowRead: z
        .array(z.string())
        .optional()
        .describe(
          'Paths to re-allow reading within denyRead regions. ' +
            'Takes precedence over denyRead for matching paths.',
        ),
      allowManagedReadPathsOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (set in managed settings), only allowRead paths from policySettings are used.',
        ),
    })
    .optional(),
)

/**
 * Sandbox settings schema.
 */
export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      failIfUnavailable: z
        .boolean()
        .optional()
        .describe(
          'Exit with an error at startup if sandbox.enabled is true but the sandbox cannot start ' +
            '(missing dependencies, unsupported platform, or platform not in enabledPlatforms). ' +
            'When false (default), a warning is shown and commands run unsandboxed. ' +
            'Intended for managed-settings deployments that require sandboxing as a hard gate.',
        ),
      // Note: enabledPlatforms is an undocumented setting read via .passthrough()
      // It restricts sandboxing to specific platforms (e.g., ["macos"]).
      //
      // Added to unblock NVIDIA enterprise rollout: they want to enable
      // autoAllowBashIfSandboxed but only on macOS initially, since Linux/WSL
      // sandbox support is newer and less battle-tested. This allows them to
      // set enabledPlatforms: ["macos"] to disable sandbox (and auto-allow)
      // on other platforms until they're ready to expand.
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z
        .boolean()
        .optional()
        .describe(
          'Allow commands to run outside the sandbox via the dangerouslyDisableSandbox parameter. ' +
            'When false, the dangerouslyDisableSandbox parameter is completely ignored and all commands must run sandboxed. ' +
            'Default: true.',
        ),
      network: SandboxNetworkConfigSchema(),
      filesystem: SandboxFilesystemConfigSchema(),
      ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
      enableWeakerNestedSandbox: z.boolean().optional(),
      enableWeakerNetworkIsolation: z
        .boolean()
        .optional()
        .describe(
          'macOS only: Allow access to com.apple.trustd.agent in the sandbox. ' +
            'Needed for Go-based CLI tools (gh, gcloud, terraform, etc.) to verify TLS certificates ' +
            'when using httpProxyPort with a MITM proxy and custom CA. ' +
            '**Reduces security** — opens a potential data exfiltration vector through the trustd service. Default: false',
        ),
      excludedCommands: z.array(z.string()).optional(),
      // Strict-mode gates (enterprise policy shape): when strictSandboxMode
      // is on, dangerouslyDisableSandbox is refused outright unless the
      // command is on an explicit allowlist; unsandboxedCommandsDisabled is
      // the hard no-escape flag (independent of allowUnsandboxedCommands —
      // either one set false disables the escape hatch).
      strictSandboxMode: z
        .boolean()
        .optional()
        .describe(
          'Managed-deployment strict mode: commands may not opt out of the ' +
            'sandbox via dangerouslyDisableSandbox; calls are refused unless ' +
            'explicitly allowlisted by policy.',
        ),
      unsandboxedCommandsDisabled: z
        .boolean()
        .optional()
        .describe(
          'Hard-disable the dangerouslyDisableSandbox escape hatch, ' +
            'independently of allowUnsandboxedCommands. Default: false.',
        ),
      ripgrep: z
        .object({
          command: z.string(),
          args: z.array(z.string()).optional(),
        })
        .optional()
        .describe('Custom ripgrep configuration for bundled ripgrep support'),
    })
    .passthrough(),
)

// Inferred types from schemas
export type SandboxSettings = z.infer<ReturnType<typeof SandboxSettingsSchema>>
export type SandboxNetworkConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxNetworkConfigSchema>>
>
export type SandboxFilesystemConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxFilesystemConfigSchema>>
>
export type SandboxIgnoreViolations = NonNullable<
  SandboxSettings['ignoreViolations']
>
