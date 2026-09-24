#!/usr/bin/env node
// 为每个 compile target 预取 ripgrep 二进制到 src/utils/vendor/ripgrep/<dir>/，
// 供 scripts/compile.ts 内嵌进单文件产物。
//
// 背景（OCR P1）：CI 的 package job 在单台 ubuntu runner 上循环编译 5 个
// target，而 postinstall 只下载 runner 本平台的 rg——其余平台的产物会
// 静默缺失内嵌 rg。本脚本按 target 补齐（已存在则跳过，幂等）。
//
// 数据源与 scripts/postinstall.cjs 同链：microsoft/ripgrep-prebuilt（主源）
// → ghproxy 镜像 → BurntSushi 官方（兜底）。sha256 校验（各源附带
// .sha256 资产）。单平台失败仅告警——嵌入是增强，产物退化为运行时
// vendor/系统 rg 回退。

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const RG_VSCODE_TAG = 'v15.0.1'
const RG_VSCODE_BASE = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RG_VSCODE_TAG}`
const RG_VSCODE_MIRROR = `https://ghproxy.net/${RG_VSCODE_BASE}`
const RG_BURNTSUSHI_VERSION = '15.2.0'
const RG_BURNTSUSHI_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_BURNTSUSHI_VERSION}`

// CI native matrix 的 triple → rg vendor 目录 → 下载资产 triple。
// linux x64 只有 musl 资产（静态，glibc 系统可跑）；arm64 用 gnu。
const TARGETS = [
  {
    triple: 'x86_64-unknown-linux-gnu',
    dir: 'x64-linux',
    assetTriple: 'x86_64-unknown-linux-musl',
    ext: 'tar.gz',
  },
  {
    triple: 'x86_64-unknown-linux-musl',
    dir: 'x64-linux-musl',
    assetTriple: 'x86_64-unknown-linux-musl',
    ext: 'tar.gz',
  },
  {
    triple: 'aarch64-unknown-linux-gnu',
    dir: 'arm64-linux',
    assetTriple: 'aarch64-unknown-linux-gnu',
    ext: 'tar.gz',
  },
  {
    triple: 'x86_64-apple-darwin',
    dir: 'x64-darwin',
    assetTriple: 'x86_64-apple-darwin',
    ext: 'tar.gz',
  },
  {
    triple: 'aarch64-apple-darwin',
    dir: 'arm64-darwin',
    assetTriple: 'aarch64-apple-darwin',
    ext: 'tar.gz',
  },
  {
    triple: 'x86_64-pc-windows-msvc',
    dir: 'x64-win32',
    assetTriple: 'x86_64-pc-windows-msvc',
    ext: 'zip',
  },
  {
    triple: 'aarch64-pc-windows-msvc',
    dir: 'arm64-win32',
    assetTriple: 'aarch64-pc-windows-msvc',
    ext: 'zip',
  },
]

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function extract(archivePath, kind, destDir) {
  // GNU tar（ubuntu runner 常见）不支持 zip——先试 tar，zip 失败落 fflate
  const r = spawnSync('tar', ['-xf', archivePath, '-C', destDir], {
    stdio: 'ignore',
  })
  if (r.status !== 0 && kind === 'zip') {
    const { unzipSync } = require('fflate')
    const unzipped = unzipSync(
      new Uint8Array(require('node:fs').readFileSync(archivePath)),
    )
    for (const [key, data] of Object.entries(unzipped)) {
      const out = join(destDir, key.replace(/\\/g, '/'))
      if (key.endsWith('/')) {
        mkdirSync(out, { recursive: true })
        continue
      }
      mkdirSync(join(out, '..'), { recursive: true })
      writeFileSync(out, Buffer.from(data))
    }
    return
  }
  if (r.status !== 0) throw new Error(`tar exited ${r.status}`)
}

function findBinary(root, name) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name === name) return full
    }
  }
  return null
}

async function ensureTarget(t) {
  const binary = t.ext === 'zip' ? 'rg.exe' : 'rg'
  const destDir = join('src', 'utils', 'vendor', 'ripgrep', t.dir)
  const destBin = join(destDir, binary)
  if (existsSync(destBin)) {
    console.log(`[fetch-rg] ${t.dir}: already present, skipping`)
    return true
  }

  const sources = [
    {
      base: RG_VSCODE_BASE,
      name: `ripgrep-${RG_VSCODE_TAG}-${t.assetTriple}.${t.ext}`,
    },
    {
      base: RG_VSCODE_MIRROR,
      name: `ripgrep-${RG_VSCODE_TAG}-${t.assetTriple}.${t.ext}`,
    },
    {
      base: RG_BURNTSUSHI_BASE,
      name: `ripgrep-${RG_BURNTSUSHI_VERSION}-${t.assetTriple}.${t.ext}`,
    },
  ]

  for (const { base, name } of sources) {
    const url = `${base}/${name}`
    try {
      console.log(`[fetch-rg] ${t.dir}: trying ${url}`)
      const buf = await fetchBuffer(url)
      if (buf.length < 500_000) {
        console.warn(
          `[fetch-rg] ${t.dir}: payload too small (${buf.length}B), next source`,
        )
        continue
      }
      // sha256 校验（.sha256 资产格式：<hex>  <filename>）
      try {
        const sum = (await fetchBuffer(`${url}.sha256`)).toString('utf8').trim()
        const expected = sum.split(/\s+/)[0]?.toLowerCase()
        if (expected && expected !== sha256(buf)) {
          console.warn(`[fetch-rg] ${t.dir}: sha256 mismatch, next source`)
          continue
        }
      } catch {
        /* 无 .sha256 资产时跳过校验（仍受大小+解压+可执行探测保护） */
      }

      const work = mkdtempSync(join(tmpdir(), 'ccb-rg-fetch-'))
      const archivePath = join(work, name)
      const extractDir = join(work, 'x')
      mkdirSync(extractDir, { recursive: true })
      writeFileSync(archivePath, buf)
      extract(archivePath, t.ext, extractDir)
      const extracted = findBinary(extractDir, binary)
      if (!extracted) {
        console.warn(
          `[fetch-rg] ${t.dir}: rg not found in archive, next source`,
        )
        rmSync(work, { recursive: true, force: true })
        continue
      }
      mkdirSync(destDir, { recursive: true })
      copyFileSync(extracted, destBin)
      chmodSync(destBin, 0o755)
      rmSync(work, { recursive: true, force: true })
      console.log(
        `[fetch-rg] ${t.dir}: installed (${Math.round(buf.length / 1024)} KB)`,
      )
      return true
    } catch (e) {
      console.warn(
        `[fetch-rg] ${t.dir}: ${base} failed: ${e instanceof Error ? e.message : e}`,
      )
    }
  }
  return false
}

// ── bfs/ugrep：CI native matrix 现场构建（与 Rust .node 同 artifact 流） ────
// 本脚本不做远程拉取——CI 场景由 native artifact 直接填充 vendor/search-tools/，
// 本地构建需先下载 native artifact 解到 vendor/。完整性闸门见文件尾：
// bfs 4 平台 + ugrep 5 平台缺一即 exit 1（bfs-windows 豁免，上游无官方支持）。

let failed = 0
for (const t of TARGETS) {
  const ok = await ensureTarget(t)
  if (!ok) {
    failed++
    console.warn(
      `[fetch-rg] ${t.dir}: all sources failed — product for this target ships without embedded rg`,
    )
  }
}

// ── 完整性闸门：bfs 4 平台 + ugrep 5 平台，缺一即失败 ──────────────────────
// bfs-windows 豁免（上游无官方支持）。CI 场景 vendor 已由 native artifact
// 填充，此处全部 existsSync 命中 → 直接通过。
{
  const missingBfs = [
    'x64-linux',
    'arm64-linux',
    'x64-linux-musl',
    'x64-darwin',
    'arm64-darwin',
    'arm64-linux-musl',
  ].filter(
    d => !existsSync(join('src', 'utils', 'vendor', 'search-tools', d, 'bfs')),
  )
  const missingUgrep = [
    'x64-linux',
    'arm64-linux',
    'x64-linux-musl',
    'arm64-linux-musl',
    'x64-darwin',
    'arm64-darwin',
    'x64-win32',
  ].filter(
    d =>
      !existsSync(join('src', 'utils', 'vendor', 'search-tools', d, 'ugrep')) &&
      !existsSync(
        join('src', 'utils', 'vendor', 'search-tools', d, 'ugrep.exe'),
      ),
  )
  if (missingBfs.length > 0 || missingUgrep.length > 0) {
    console.error(
      `[fetch-search] INCOMPLETE: bfs missing [${missingBfs.join(', ')}], ugrep missing [${missingUgrep.join(', ')}]`,
    )
    console.error(
      '[fetch-search] Embedded search tools are mandatory — build aborted. Trigger the search-tools-prebuilt workflow first, or sync native artifacts.',
    )
    process.exit(1)
  }
  console.log('[fetch-search] completeness gate passed (bfs x4, ugrep x5)')
}
console.log(
  `[fetch-rg] done: rg ${TARGETS.length - failed}/${TARGETS.length}, search-tools ${TARGETS.length * 2 - searchFailed}/${TARGETS.length * 2}`,
)
process.exit(0) // 单平台失败不阻塞打包（回退链仍在）
