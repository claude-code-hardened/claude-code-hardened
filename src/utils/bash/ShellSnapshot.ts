import { execFile } from 'child_process'
import { execa } from 'execa'
import { chmodSync } from 'fs'
import { mkdir, stat } from 'fs/promises'
import * as os from 'os'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { pathExists } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { quote } from './shellQuote.js'

const LITERAL_BACKSLASH = '\\'

/**
 * pkill shadow（官方原文 1:1）：pgrep 探测用户 pattern，若匹配 CLAUDE_PID
 * 则拒绝执行——防止用户 pkill 误杀 CLI 自身进程。
 */
function createPkillShadow(): string {
  return [
    'unalias pkill 2>/dev/null || true',
    'function pkill {',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 源码字面（${} 是 shell 语法非 TS 模板）
    '  if [ -n "${CLAUDE_PID:-}" ] && [ -r "/proc/${CLAUDE_PID}/comm" ]; then',
    '    local _cc_skip="" _cc_a',
    '    local -a _cc_probe=()',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 源码字面（${} 是 shell 语法非 TS 模板）
    '    for _cc_a in ${1+"$@"}; do',
    '      if [ -n "$_cc_skip" ]; then _cc_skip=""; continue; fi',
    '      case "$_cc_a" in',
    '        --signal) _cc_skip=1 ;;',
    '        --signal=*|-e|--echo) ;;',
    '        -[0-9]*) ;;',
    '        -[PUGOF]?*) _cc_probe+=("$_cc_a") ;;',
    '        -[ABCDEFGHIJKLMNOPQRSTUVWXYZ][ABCDEFGHIJKLMNOPQRSTUVWXYZ0-9]*) ;;',
    '        *) _cc_probe+=("$_cc_a") ;;',
    '      esac',
    '    done',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 源码字面（${} 是 shell 语法非 TS 模板）
    '    if command pgrep ${_cc_probe[@]+"${_cc_probe[@]}"} 2>/dev/null | command grep -qx "${CLAUDE_PID}"; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 源码字面（${} 是 shell 语法非 TS 模板）
    '      printf \'pkill: refusing to run \u2014 this pattern matches the Claude CLI process (PID %s). Narrow the pattern, or target your own children with `pkill -P $$ ...`.\\n\' "${CLAUDE_PID}" >&2',
    '      return 1',
    '    fi',
    '  fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 源码字面（${} 是 shell 语法非 TS 模板）
    '  command pkill ${1+"$@"}',
    '}',
  ].join('\n')
}
const SNAPSHOT_CREATION_TIMEOUT = 10000 // 10 seconds

function getConfigFile(shellPath: string): string {
  const fileName = shellPath.includes('zsh')
    ? '.zshrc'
    : shellPath.includes('bash')
      ? '.bashrc'
      : '.profile'

  const configPath = join(os.homedir(), fileName)

  return configPath
}

/**
 * Generates user-specific snapshot content (functions, options, aliases)
 * This content is derived from the user's shell configuration file
 */
function getUserSnapshotContent(configFile: string): string {
  const isZsh = configFile.endsWith('.zshrc')

  let content = ''

  // User functions
  if (isZsh) {
    content += `
      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      typeset -f > /dev/null 2>&1

      # Now get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)
      typeset +f | grep -vE '^_[^_]' | while read func; do
        typeset -f "$func" >> "$SNAPSHOT_FILE"
      done
    `
  } else {
    content += `
      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      declare -f > /dev/null 2>&1

      # Now get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)
      declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do
        # Encode the function to base64, preserving all special characters
        encoded_func=$(declare -f "$func" | base64 )
        # Write the function definition to the snapshot
        echo "eval ${LITERAL_BACKSLASH}"${LITERAL_BACKSLASH}$(echo '$encoded_func' | base64 -d)${LITERAL_BACKSLASH}" > /dev/null 2>&1" >> "$SNAPSHOT_FILE"
      done
    `
  }

  // Shell options
  if (isZsh) {
    content += `
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      setopt | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"
    `
  } else {
    content += `
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"
      set -o | grep "on" | awk '{print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
      echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
    `
  }

  // User aliases
  content += `
      echo "# Aliases" >> "$SNAPSHOT_FILE"
      # Filter out winpty aliases on Windows to avoid "stdin is not a tty" errors
      # Git Bash automatically creates aliases like "alias node='winpty node.exe'" for
      # programs that need Win32 Console in mintty, but winpty fails when there's no TTY
      if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        alias | grep -v "='winpty " | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
      else
        alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
      fi
  `

  return content
}

/**
 * Generates Claude Code specific snapshot content
 * This content is always included regardless of user configuration
 */
async function getClaudeCodeSnapshotContent(): Promise<string> {
  // Get the appropriate PATH based on platform
  let pathValue = process.env.PATH
  if (getPlatform() === 'windows') {
    // On Windows with git-bash, read the Cygwin PATH
    const cygwinResult = await execa('echo $PATH', {
      shell: true,
      reject: false,
    })
    if (cygwinResult.exitCode === 0 && cygwinResult.stdout) {
      pathValue = cygwinResult.stdout.trim()
    }
    // Fall back to process.env.PATH if we can't get Cygwin PATH
  }

  // (rg alias/function 注入已随 rg 外挂链整体退役拆除：CCH 不再自带
  // ripgrep 二进制，也不再替用户 shadow 系统 rg——与 find/grep shadow 的
  // 拆除裁定一致。)

  let content = ''

  // pkill shadow（官方 snapshot 同款安全特性，非人性化项）：防止用户
  // pkill 误杀 CLI 自身进程。原 find/grep→bfs/ugrep shadow 已拆除，此
  // 安全特性保留并独立注入。
  content += `
      # pkill shadow: refuse to kill the Claude CLI process itself
      echo "# pkill shadow" >> "$SNAPSHOT_FILE"
      cat >> "$SNAPSHOT_FILE" << 'PKILL_SHADOW_END'
${createPkillShadow()}
PKILL_SHADOW_END
  `

  // Add PATH to the file
  content += `

      # Add PATH to the file
      echo "export PATH=${quote([pathValue || ''])}" >> "$SNAPSHOT_FILE"
  `

  return content
}

/**
 * Creates the appropriate shell script for capturing environment
 */
async function getSnapshotScript(
  shellPath: string,
  snapshotFilePath: string,
  configFileExists: boolean,
): Promise<string> {
  const configFile = getConfigFile(shellPath)
  const isZsh = configFile.endsWith('.zshrc')

  // Generate the user content and Claude Code content
  const userContent = configFileExists
    ? getUserSnapshotContent(configFile)
    : !isZsh
      ? // we need to manually force alias expansion in bash - normally `getUserSnapshotContent` takes care of this
        'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'
      : ''
  const claudeCodeContent = await getClaudeCodeSnapshotContent()

  const script = `SNAPSHOT_FILE=${quote([snapshotFilePath])}
      ${configFileExists ? `source "${configFile}" < /dev/null` : '# No user config file to source'}

      # First, create/clear the snapshot file
      echo "# Snapshot file" >| "$SNAPSHOT_FILE"

      # When this file is sourced, we first unalias to avoid conflicts
      # This is necessary because aliases get "frozen" inside function definitions at definition time,
      # which can cause unexpected behavior when functions use commands that conflict with aliases
      echo "# Unset all aliases to avoid conflicts with functions" >> "$SNAPSHOT_FILE"
      echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"

      ${userContent}

      ${claudeCodeContent}

      # Exit silently on success, only report errors
      if [ ! -f "$SNAPSHOT_FILE" ]; then
        echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2
        exit 1
      fi
    `

  return script
}

/**
 * Creates and saves the shell environment snapshot by loading the user's shell configuration
 *
 * This function is a critical part of Claude CLI's shell integration strategy. It:
 *
 * 1. Identifies the user's shell config file (.zshrc, .bashrc, etc.)
 * 2. Creates a temporary script that sources this configuration file
 * 3. Captures the resulting shell environment state including:
 *    - Functions defined in the user's shell configuration
 *    - Shell options and settings that affect command behavior
 *    - Aliases that the user has defined
 *
 * The snapshot is saved to a temporary file that can be sourced by subsequent shell
 * commands, ensuring they run with the user's expected environment, aliases, and functions.
 *
 * This approach allows Claude CLI to execute commands as if they were run in the user's
 * interactive shell, while avoiding the overhead of creating a new login shell for each command.
 * It handles both Bash and Zsh shells with their different syntax for functions, options, and aliases.
 *
 * If the snapshot creation fails (e.g., timeout, permissions issues), the CLI will still
 * function but without the user's custom shell environment, potentially missing aliases
 * and functions the user relies on.
 *
 * @returns Promise that resolves to the snapshot file path or undefined if creation failed
 */
export const createAndSaveSnapshot = async (
  binShell: string,
): Promise<string | undefined> => {
  const shellType = binShell.includes('zsh')
    ? 'zsh'
    : binShell.includes('bash')
      ? 'bash'
      : 'sh'

  logForDebugging(`Creating shell snapshot for ${shellType} (${binShell})`)

  // biome-ignore lint/suspicious/noAsyncPromiseExecutor: async needed for sequential awaits inside executor
  return new Promise(async resolve => {
    try {
      const configFile = getConfigFile(binShell)
      logForDebugging(`Looking for shell config file: ${configFile}`)
      const configFileExists = await pathExists(configFile)

      if (!configFileExists) {
        logForDebugging(
          `Shell config file not found: ${configFile}, creating snapshot with Claude Code defaults only`,
        )
      }

      // Create unique snapshot path with timestamp and random ID
      const timestamp = Date.now()
      const randomId = Math.random().toString(36).substring(2, 8)
      const snapshotsDir = join(getClaudeConfigHomeDir(), 'shell-snapshots')
      logForDebugging(`Snapshots directory: ${snapshotsDir}`)
      const shellSnapshotPath = join(
        snapshotsDir,
        `snapshot-${shellType}-${timestamp}-${randomId}.sh`,
      )

      // Ensure snapshots directory exists. Owner-only: snapshots may embed
      // user environment data that gets sourced into every shell command.
      await mkdir(snapshotsDir, { recursive: true, mode: 0o700 })

      const snapshotScript = await getSnapshotScript(
        binShell,
        shellSnapshotPath,
        configFileExists,
      )
      logForDebugging(`Creating snapshot at: ${shellSnapshotPath}`)
      logForDebugging(`Execution timeout: ${SNAPSHOT_CREATION_TIMEOUT}ms`)
      execFile(
        binShell,
        ['-c', '-l', snapshotScript],
        {
          env: {
            ...((process.env.CLAUDE_CODE_DONT_INHERIT_ENV
              ? {}
              : subprocessEnv()) as typeof process.env),
            SHELL: binShell,
            GIT_EDITOR: 'true',
            CLAUDECODE: '1',
          },
          timeout: SNAPSHOT_CREATION_TIMEOUT,
          maxBuffer: 1024 * 1024, // 1MB buffer
          encoding: 'utf8',
        },
        async (error, stdout, stderr) => {
          if (error) {
            const execError = error as Error & {
              killed?: boolean
              signal?: string
              code?: number
            }
            logForDebugging(`Shell snapshot creation failed: ${error.message}`)
            logForDebugging(`Error details:`)
            logForDebugging(`  - Error code: ${execError?.code}`)
            logForDebugging(`  - Error signal: ${execError?.signal}`)
            logForDebugging(`  - Error killed: ${execError?.killed}`)
            logForDebugging(`  - Shell path: ${binShell}`)
            logForDebugging(`  - Config file: ${getConfigFile(binShell)}`)
            logForDebugging(`  - Config file exists: ${configFileExists}`)
            logForDebugging(`  - Working directory: ${getCwd()}`)
            logForDebugging(`  - Claude home: ${getClaudeConfigHomeDir()}`)
            logForDebugging(`Full snapshot script:\n${snapshotScript}`)
            if (stdout) {
              logForDebugging(
                `stdout output (${stdout.length} chars):\n${stdout}`,
              )
            } else {
              logForDebugging(`No stdout output captured`)
            }
            if (stderr) {
              logForDebugging(
                `stderr output (${stderr.length} chars): ${stderr}`,
              )
            } else {
              logForDebugging(`No stderr output captured`)
            }
            logError(
              new Error(`Failed to create shell snapshot: ${error.message}`),
            )
            // Convert signal name to number if present
            const signalNumber = execError?.signal
              ? os.constants.signals[
                  execError.signal as keyof typeof os.constants.signals
                ]
              : undefined
            logEvent('tengu_shell_snapshot_failed', {
              stderr_length: stderr?.length || 0,
              has_error_code: !!execError?.code,
              error_signal_number: signalNumber,
              error_killed: execError?.killed,
            })
            resolve(undefined)
          } else {
            let snapshotSize: number | undefined
            try {
              snapshotSize = (await stat(shellSnapshotPath)).size
            } catch {
              // Snapshot file not found
            }

            if (snapshotSize !== undefined) {
              // Owner-only permissions: the snapshot can embed user env and
              // aliases. The CLI's own shells later `source` it as the same
              // user (bashProvider.ts: `source <path> 2>/dev/null || true`),
              // so 0600 keeps them readable where it matters.
              try {
                chmodSync(shellSnapshotPath, 0o600)
              } catch (chmodError) {
                logForDebugging(
                  `Failed to chmod shell snapshot ${shellSnapshotPath} to 0600: ${chmodError}`,
                )
              }
              logForDebugging(
                `Shell snapshot created successfully (${snapshotSize} bytes)`,
              )

              // Register cleanup to remove snapshot on graceful shutdown
              registerCleanup(async () => {
                try {
                  await getFsImplementation().unlink(shellSnapshotPath)
                  logForDebugging(
                    `Cleaned up session snapshot: ${shellSnapshotPath}`,
                  )
                } catch (error) {
                  logForDebugging(
                    `Error cleaning up session snapshot: ${error}`,
                  )
                }
              })

              resolve(shellSnapshotPath)
            } else {
              logForDebugging(
                `Shell snapshot file not found after creation: ${shellSnapshotPath}`,
              )
              logForDebugging(
                `Checking if parent directory still exists: ${snapshotsDir}`,
              )
              try {
                const dirContents =
                  await getFsImplementation().readdir(snapshotsDir)
                logForDebugging(
                  `Directory contains ${dirContents.length} files`,
                )
              } catch {
                logForDebugging(
                  `Parent directory does not exist or is not accessible: ${snapshotsDir}`,
                )
              }
              logEvent('tengu_shell_unknown_error', {})
              resolve(undefined)
            }
          }
        },
      )
    } catch (error) {
      logForDebugging(`Unexpected error during snapshot creation: ${error}`)
      if (error instanceof Error) {
        logForDebugging(`Error stack trace: ${error.stack}`)
      }
      logError(error)
      logEvent('tengu_shell_snapshot_error', {})
      resolve(undefined)
    }
  })
}
