/**
 * Server logger: timestamped stderr writer shared by every `claude server`
 * component. stderr (not stdout) so the REPL/HTTP surfaces stay clean.
 *
 * TODO(下一代): rotating file sink under $CLAUDE_CONFIG_DIR/server-logs/
 * gated by CLAUDE_SERVER_LOG, and structured (JSON) mode for RCS ingestion.
 */

export interface ServerLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, message: string): void {
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${message}\n`)
}

export const createServerLogger: () => ServerLogger = () => {
  const logger: ServerLogger = {
    debug(message: string) {
      if (process.env.CLAUDE_SERVER_DEBUG === '1') {
        emit('debug', message)
      }
    },
    info(message: string) {
      emit('info', message)
    },
    warn(message: string) {
      emit('warn', message)
    },
    error(message: string) {
      emit('error', message)
    },
  }
  return logger
}
