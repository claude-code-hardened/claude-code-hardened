/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * This checks for embedded files which are present in compiled binaries.
 */
export function isInBundledMode(): boolean {
  if (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  ) {
    return true
  }
  // 兜底（unknown option 实测排查，2026-09-27）：bun 1.4.2 的
  // compile + bytecode + minify 组合下 Bun.embeddedFiles 曾返回空数组，
  // isInBundledMode() 误判 false → buildCliLaunch 走 script 分支拼出
  // [SCRIPT_PATH(bunfs), --daemon-worker=…] 畸形 argv，child 落到
  // commander 报 unknown option。argv[1] 为 bunfs 虚拟路径 = compile
  // self-exec 的铁证（dev 模式 argv[1] 是真实脚本路径，不受影响）。
  const a1 = process.argv[1] ?? ''
  return a1.startsWith('/$bunfs/') || a1.startsWith('/$BUNFS/')
}
