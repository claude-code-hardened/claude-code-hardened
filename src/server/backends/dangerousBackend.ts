/**
 * Dangerous backend — the session subprocess dispatcher for
 * `claude server`. "Dangerous" = spawns child sessions with
 * --dangerously-skip-permissions when requested: the server has no
 * interactive approver, so clients explicitly opt in per session.
 */

export interface SpawnRequest {
  dangerouslySkipPermissions?: boolean
}

export interface SpawnCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export class DangerousBackend {
  readonly name = 'dangerous'

  /**
   * Build the child process invocation. The parent CLI process is reused
   * (process.execPath + process.argv[1]) so the spawned session runs the
   * exact binary currently serving.
   *
   * Stream-json in/out is the wire format the DirectConnect client speaks:
   * user messages in, assistant/result control frames out.
   *
   * TODO(下一代): permission-mode plumbing beyond dangerous (acceptSessions
   * policy, --permission-mode pass-through) and long-lived REPL replacement
   * (`--print` caps a session at one conversation turn stream).
   */
  buildSpawnCommand(request: SpawnRequest = {}): SpawnCommand {
    const cliPath = process.argv[1]
    const args: string[] = []
    if (cliPath) {
      args.push(cliPath)
    }
    args.push(
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    )
    if (request.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions')
    }
    return {
      command: process.execPath,
      args,
      env: { ...process.env },
    }
  }

  /**
   * Server-side dispatch for inbound user messages before they reach the
   * subprocess stdin. Currently pass-through; hook point for rate limits,
   * message rewriting, or ledger tagging (official _ALL.js deliveryLedger).
   */
  transformInboundMessage(message: string): string {
    return message
  }
}
