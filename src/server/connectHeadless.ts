import type { DirectConnectConfig } from './directConnectManager.js'
import { DirectConnectSessionManager } from './directConnectManager.js'
import { jsonStringify } from '../utils/slowOperations.js'

/**
 * Headless direct-connect runner (`claude open cc://... -p <prompt>`).
 *
 * Really connects over the WebSocket call protocol, sends the prompt, prints
 * assistant/result output in the requested format, and exits 0 on result.
 * Every failure path — refused socket, auth rejection, open timeout, closed
 * connection before result — writes to stderr and exits non-zero.
 *
 * The open deadline is explicit on purpose: generations 1-3 died silently on
 * connection timeouts against servers whose listeners never actually bound
 * (stub `startServer`). Default 15s, CLAUDE_CONNECT_TIMEOUT_MS overrides.
 */

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string') return b.text
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

async function readStdinPrompt(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise<string>(resolve => {
    const stdinStream = process.stdin
    const chunks: Buffer[] = []
    stdinStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stdinStream.on('end', () =>
      resolve(Buffer.concat(chunks).toString('utf8').trim()),
    )
    stdinStream.on('error', () => resolve(''))
  })
}

export const runConnectHeadless = async (
  config: DirectConnectConfig,
  prompt: string,
  outputFormat: string,
  interactive: boolean,
): Promise<void> => {
  let userPrompt = prompt
  if (userPrompt === '' && interactive) {
    userPrompt = await readStdinPrompt()
  }
  if (userPrompt === '') {
    process.stderr.write(
      'No prompt provided — pass one with -p "<prompt>" or pipe it via stdin\n',
    )
    process.exit(1)
  }

  const timeoutMs = Number.parseInt(
    process.env.CLAUDE_CONNECT_TIMEOUT_MS ?? '',
    10,
  )
  const openTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000

  let exitCode = 0
  let settled = false

  const finish = (code: number, message?: string): void => {
    if (settled) return
    settled = true
    if (message) {
      process.stderr.write(`${message}\n`)
    }
    process.exit(code)
  }

  const session = new DirectConnectSessionManager(config, {
    onMessage: message => {
      const msg = message as unknown as Record<string, unknown>
      if (msg.type === 'assistant') {
        const inner = msg.message as Record<string, unknown> | undefined
        const text = extractText(inner?.content)
        if (outputFormat === 'text') {
          if (text !== '') {
            process.stdout.write(`${text}\n`)
          }
        } else {
          process.stdout.write(`${jsonStringify(message)}\n`)
        }
      } else if (msg.type === 'result') {
        exitCode = msg.is_error === true ? 1 : 0
        if (outputFormat === 'text') {
          const text = extractText(msg.result)
          if (text !== '') {
            process.stdout.write(`${text}\n`)
          }
        } else {
          process.stdout.write(`${jsonStringify(message)}\n`)
        }
        session.disconnect()
        finish(exitCode)
      } else if (outputFormat === 'stream-json' && msg.type !== 'system') {
        process.stdout.write(`${jsonStringify(message)}\n`)
      }
    },
    onPermissionRequest: (request, requestId) => {
      // Headless has nobody to approve a tool use.
      session.respondToPermissionRequest(requestId, {
        behavior: 'deny',
        message:
          'Permission prompts are unavailable in headless connect mode (use --dangerously-skip-permissions on the server side)',
      })
    },
    onConnected: () => {
      if (!session.sendMessage(userPrompt)) {
        finish(1, `Failed to send prompt to ${config.serverUrl}`)
      }
    },
    onDisconnected: () => {
      finish(1, 'Connection closed before the session completed')
    },
    onError: (err: Error) => {
      finish(
        1,
        `Connection error talking to ${config.serverUrl}: ${err.message}`,
      )
    },
  })

  const openTimer = setTimeout(() => {
    session.disconnect()
    finish(
      1,
      `Connection to ${config.serverUrl} timed out after ${openTimeoutMs}ms — is the server reachable (claude server running, correct port/token)?`,
    )
  }, openTimeoutMs)

  session.connect()
  void openTimer.unref?.()
}
