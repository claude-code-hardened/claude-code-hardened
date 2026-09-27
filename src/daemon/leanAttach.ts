import { messagingRequest } from './messagingClient.js'
import { officialControlSockPath } from './controlProtocol.js'
import { readFileSync } from 'fs'
import { connect } from 'net'

/**
 * lean client 终端级附着——不进 Ink REPL，直接 proxy 会话流：
 *
 *   stdout ← messagingRequest('read', { lines: tail })
 *   stdin  → messagingRequest('send', { text: line })
 *
 * 入口检查（list 拿 messagingSock 路径）走 control plane（闸 1+3 vet）。
 * CCB_TUI_SPAWN=1 的强制旧路由 replLauncher 处理，不在此层。
 */

export interface AttachTarget {
  short: string
  messagingSock: string
  name?: string
  engine?: string
}

/** 从 control plane 的 list 拿目标会话（short 寻址，闸 1+3 vet 侧）。 */
export async function findAttachTarget(
  short: string,
): Promise<AttachTarget | null> {
  return await new Promise(resolve => {
    const sock = connect(officialControlSockPath())
    let buf = ''
    const finish = (r: AttachTarget | null) => {
      sock.destroy()
      resolve(r)
    }
    sock.setTimeout(3_000, () => finish(null))
    sock.once('connect', () => {
      let key: string | undefined
      try {
        key = readFileSync('/root/.claude/daemon/control.key', 'utf8').trim()
      } catch {}
      sock.write(JSON.stringify({ op: 'list', auth: key }) + '\n')
    })
    sock.on('data', d => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      try {
        const resp = JSON.parse(buf.slice(0, i)) as {
          ok: boolean
          jobs?: Array<{
            short?: string
            messagingSock?: string
            name?: string
            engine?: string
          }>
        }
        if (!resp.ok || !resp.jobs) return finish(null)
        const job = resp.jobs.find(j => j.short === short)
        if (!job) return finish(null)
        finish({
          short,
          messagingSock: String(job.messagingSock ?? ''),
          name: job.name as string | undefined,
          engine: job.engine as string | undefined,
        })
      } catch {
        finish(null)
      }
    })
    sock.on('error', () => finish(null))
  })
}

/**
 * 附着循环：每 500ms read tail；stdin 行 → send。
 * Ctrl-C 退出循环（进程退出，会话不杀——daemon 托管生命周期）。
 */
export async function leanAttachLoop(target: AttachTarget): Promise<void> {
  if (!target.messagingSock) {
    console.error('session has no messaging socket')
    process.exitCode = 1
    return
  }
  let lastLines = 0
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    const line = String(chunk).trim()
    if (line)
      void messagingRequest(target.messagingSock, 'send', { text: line })
  })

  for (;;) {
    try {
      const resp = await messagingRequest(target.messagingSock, 'read', {
        lines: 30,
      })
      if (resp.ok) {
        const output = (resp as { output: string[] }).output
        const fresh = output.slice(
          lastLines > 0 ? Math.min(lastLines, output.length) : 0,
        )
        if (fresh.length > 0) {
          for (const line of fresh) process.stdout.write(line + '\n')
        }
        lastLines =
          output.length > 0
            ? Math.min(lastLines + fresh.length, output.length)
            : 0
      } else if ((resp as { alive: boolean }).alive === false) {
        console.error('session exited')
        process.exitCode = 1
        return
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      // 官方错误分类：EKICKED:（被人工踢出）/E[A-Z]+:（协议错误前缀）
      if (/^EKICKED:\s*/.test(raw)) {
        console.error(raw.replace(/^EKICKED:\s*/, 'session kicked: '))
        process.exitCode = 1
        return
      }
      if (/^E[A-Z]+:/.test(raw)) {
        console.error('attach error:', raw)
        process.exitCode = 1
        return
      }
      console.error('attach error:', raw)
      process.exitCode = 1
      return
    }
    await new Promise(r => setTimeout(r, 500))
  }
}
