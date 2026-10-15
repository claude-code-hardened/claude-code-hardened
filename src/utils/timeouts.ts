// Constants for timeout values
const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes
const MAX_TIMEOUT_MS = 600_000 // 10 minutes

type EnvLike = Record<string, string | undefined>

/**
 * Get the default timeout for bash operations in milliseconds
 * Checks BASH_DEFAULT_TIMEOUT_MS environment variable or returns 2 minutes default
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getDefaultBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_DEFAULT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_TIMEOUT_MS
}

/**
 * Get the maximum timeout for bash operations in milliseconds
 * Checks BASH_MAX_TIMEOUT_MS environment variable or returns 10 minutes default
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getMaxBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_MAX_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      // 仅当用户显式配置了 BASH_DEFAULT_TIMEOUT_MS 时才把 max 抬到 default
      // 之上；未配置 default 时必须原样尊重显式的低 ceiling（否则
      // BASH_MAX_TIMEOUT_MS=1000 之类会被内置 2 分钟 default 静默覆盖）。
      if (env.BASH_DEFAULT_TIMEOUT_MS) {
        return Math.max(parsed, getDefaultBashTimeoutMs(env))
      }
      return parsed
    }
  }
  // Always ensure max is at least as large as default
  return Math.max(MAX_TIMEOUT_MS, getDefaultBashTimeoutMs(env))
}
