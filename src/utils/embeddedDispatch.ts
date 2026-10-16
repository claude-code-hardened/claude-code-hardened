/**
 * rg argv0 分发器（rg 是工具降级链：embedded → vendor → 系统，保留）。
 *
 * compile 产物被 `exec -a rg cch`（bash）或 `ARGV0=rg execPath`
 * （zsh/Windows）调用时，cli.tsx main() 在 Commander 解析前调用本模块：
 * stage 内嵌 rg → spawnSync 透传 stdio/参数 → 以子进程退出码退出。
 *
 * stage 失败（非 Linux 且 tmpfs 不可用等极端场景）→ 落回 PATH 里的
 * rg，保证 shell 集成永不静默坏掉。
 *
 * （bfs/ugrep 的 argv0 分发已拆除：shell find/grep shadow 属"给人用"的
 * 人性化通道；AI 搜索由 GrepTool/GlobTool 承接。）
 */

import { logForDebugging } from './debug.js'
import { getEmbeddedRg } from './embeddedRg.js'
import { probeSpawnable } from './embeddedStage.js'

/**
 * 执行嵌入 rg 并返回进程退出码。永不 throw——所有失败都转为
 * PATH 回退（或 127）。
 */
export async function dispatchEmbeddedTool(
  name: 'rg',
  args: string[],
): Promise<number> {
  const { spawnSync } = await import('node:child_process')
  const staged = getEmbeddedRg()

  if (staged && probeSpawnable(staged.command)) {
    logForDebugging(
      `[dispatch] ${name}: embedded binary staged at ${staged.command}`,
    )
    const r = spawnSync(staged.command, args, { stdio: 'inherit' })
    return r.status ?? 1
  }

  // stage 失败 → PATH 回退（宿主机装了 rg 就继续可用）
  logForDebugging(
    `[dispatch] ${name}: embedded staging unavailable → PATH fallback`,
  )
  const fallback = spawnSync(name, args, { stdio: 'inherit' })
  return fallback.status ?? 127
}
