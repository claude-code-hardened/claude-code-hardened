/**
 * 单文件可执行二进制编译（bun build --compile）。
 *
 * 与 build.ts（splitting bundle）不同：compile 必须单 bundle 内嵌，
 * 不做 code splitting（chunk 是运行时外部文件，装不进二进制）。
 * 产物：dist/ccb-<os>-<arch>[.exe] —— 无需安装 Node/Bun，下载即运行。
 *
 * Native 模块嵌入策略：
 *   - 读取目标平台对应的 .node 文件
 *   - 转为 base64 注入到 bundle（通过 Bun plugin 提供 virtual module "embedded:natives"）
 *   - 运行时通过 src/utils/embeddedNative.ts 提取到临时目录加载
 *
 * usage: bun run scripts/compile.ts [target ...]
 *   target 形如 bun-linux-x64 / bun-linux-arm64 / bun-darwin-arm64 / bun-windows-x64
 *   不传则编译全部平台。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

const ALL_TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
]

const requested = process.argv.slice(2)
const targets = requested.length > 0 ? requested : ALL_TARGETS

const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

// Crate 映射：package 名 -> { crate 名（cdylib 产物名）, vendor 子目录名 }
const CRATES = [
  {
    pkg: 'token-counter-napi',
    crate: 'token_counter_napi',
    vendorDir: 'token-counter',
    moduleName: 'token-counter',
  },
  {
    pkg: 'transcript-parser-napi',
    crate: 'transcript_parser_napi',
    vendorDir: 'transcript-parser',
    moduleName: 'transcript-parser',
  },
  {
    pkg: 'color-diff-napi',
    crate: 'color_diff_napi',
    vendorDir: 'color-diff',
    moduleName: 'color-diff',
  },
  {
    pkg: 'file-index-napi',
    crate: 'file_index_napi',
    vendorDir: 'file-index',
    moduleName: 'file-index',
  },
]

function artifactName(crate: string, platform: string): string {
  if (platform.endsWith('-windows-msvc')) return `${crate}.dll`
  if (platform.endsWith('-apple-darwin')) return `lib${crate}.dylib`
  return `lib${crate}.so`
}

function targetToTriple(target: string): string {
  const map: Record<string, string> = {
    'bun-linux-x64': 'x86_64-unknown-linux-gnu',
    'bun-linux-arm64': 'aarch64-unknown-linux-gnu',
    'bun-darwin-x64': 'x86_64-apple-darwin',
    'bun-darwin-arm64': 'aarch64-apple-darwin',
    'bun-windows-x64': 'x86_64-pc-windows-msvc',
  }
  return map[target] ?? 'unknown'
}

function readNativeAsBase64(
  vendorDir: string,
  triple: string,
  moduleName: string,
): string | null {
  const candidate = join('vendor', vendorDir, triple, `${moduleName}.node`)
  if (!existsSync(candidate)) {
    console.warn(`  [embed] Native not found: ${candidate}`)
    return null
  }
  const buffer = readFileSync(candidate)
  return buffer.toString('base64')
}

// rg 的 vendor 布局用 <arch>-<platform>（如 arm64-linux），与 .node 的
// triple 命名不同。
function targetToRgDir(target: string): string {
  const map: Record<string, string> = {
    'bun-linux-x64': 'x64-linux',
    'bun-linux-arm64': 'arm64-linux',
    'bun-darwin-x64': 'x64-darwin',
    'bun-darwin-arm64': 'arm64-darwin',
    'bun-windows-x64': 'x64-win32',
  }
  return map[target] ?? 'unknown'
}

/**
 * 读取本平台 rg 二进制并转 base64。数据源是 postinstall 的下载位
 * （bun install / CI 安装阶段已就位）。找不到返回 null——产物退化为
 * 无内嵌 rg，运行时走 vendor/系统 rg 回退。
 */
function readRgAsBase64(target: string): string | null {
  const dir = targetToRgDir(target)
  // 由 target 推导（host platform 在交叉编译场景会选错文件）
  const binary = target.startsWith('bun-windows') ? 'rg.exe' : 'rg'
  const candidates = [
    join('src', 'utils', 'vendor', 'ripgrep', dir, binary),
    join('vendor', 'ripgrep', dir, binary),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const buffer = readFileSync(candidate)
      console.log(
        `  [embed] ripgrep (${dir}): ${Math.round(buffer.length / 1024)} KB`,
      )
      return buffer.toString('base64')
    }
  }
  console.warn(
    `  [embed] ripgrep not found (${candidates[0]}); binary ships without embedded rg`,
  )
  return null
}

// bfs/ugrep 的 vendor 位（fetch-rg.mjs 预取 / 自建 release 下载）。
function readSearchToolsAsBase64(target: string): {
  bfs: string | null
  ugrep: string | null
} {
  const dir = targetToRgDir(target)
  const out: { bfs: string | null; ugrep: string | null } = {
    bfs: null,
    ugrep: null,
  }
  for (const tool of ['bfs', 'ugrep'] as const) {
    const binary = target.startsWith('bun-windows') ? `${tool}.exe` : tool
    const candidates = [
      join('src', 'utils', 'vendor', 'search-tools', dir, binary),
      join('vendor', 'search-tools', dir, binary),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const buffer = readFileSync(candidate)
        console.log(
          `  [embed] ${tool} (${dir}): ${Math.round(buffer.length / 1024)} KB`,
        )
        out[tool] = buffer.toString('base64')
        break
      }
    }
    if (!out[tool]) {
      console.warn(
        `  [embed] ${tool} not found (${candidates[0]}); binary ships without embedded ${tool}`,
      )
    }
  }
  return out
}

// Create a Bun plugin that overrides src/utils/embeddedNatives.gen.ts,
// src/utils/embeddedRg.gen.ts and src/utils/embeddedSearch.gen.ts with the
// target platform's base64 payloads.
function createEmbeddedNativesPlugin(
  embeddedNatives: Record<string, string>,
  embeddedRipgrep: string | null,
  embeddedSearchTools: { bfs: string | null; ugrep: string | null },
) {
  return {
    name: 'embedded-natives',
    setup(build: any) {
      build.onResolve(
        { filter: /embedded(Natives|Rg|Search)\.gen(\.ts)?$/ },
        args => ({
          path: args.path,
          namespace: 'embedded-natives',
        }),
      )
      build.onLoad({ filter: /.*/, namespace: 'embedded-natives' }, args => {
        let contents = `export const EMBEDDED_NATIVES = ${JSON.stringify(embeddedNatives)};\n`
        if (args.path.includes('embeddedRg')) {
          contents = `export const EMBEDDED_RIPGREP = ${JSON.stringify(embeddedRipgrep)};\n`
        } else if (args.path.includes('embeddedSearch')) {
          contents = `export const EMBEDDED_SEARCH_TOOLS = ${JSON.stringify(embeddedSearchTools)};\n`
        }
        return { contents, loader: 'js' }
      })
    },
  }
}

// JSC bytecode 预编译默认启用。
// Bun 1.4.0 起 --compile + --bytecode --format=esm 支持顶层 await /
// import.meta / 动态 import（#26402）；--bytecode 会把默认 format 从
// esm 改成 cjs（见 bun build --help），故显式传 format: 'esm'。
// 代价：产物体积 +53%（111→171MB）；收益：--version 1.16s→0.20s
// （本机 aarch64 三次取中位 A/B 实测，2026-09-14）。
// 已知上游风险：oven-sh/bun#27955——bytecode+esm 在特定命名导入模式下
// 可能产生悬空模块引用的坏产物；bundle 变更后必须过 --check-commands
// 运行时冒烟（CI package job 常驻），仅静态构建成功不可信。

for (const target of targets) {
  const triple = targetToTriple(target)

  // ── 收集当前 target 的所有 native 模块 base64 ──
  const embeddedNatives: Record<string, string> = {}
  for (const { vendorDir, moduleName, crate } of CRATES) {
    const base64 = readNativeAsBase64(vendorDir, triple, moduleName)
    if (base64) {
      embeddedNatives[moduleName] = base64
      console.log(
        `  [embed] ${moduleName} (${triple}): ${Math.round((base64.length * 0.75) / 1024)} KB`,
      )
    }
  }

  // ── 收集当前 target 的 rg（可选：无文件则产物不内嵌，运行时回退）──
  const embeddedRipgrep = readRgAsBase64(target)
  const embeddedSearchTools = readSearchToolsAsBase64(target)

  // ── Bun.build --compile with embedded natives plugin ──
  // minify：compile 此前未开压缩，产物是未压缩源码，体积直接决定 JSC 的
  // 全量解析字节量（单文件 compile 无 splitting，--version 纯解析实测
  // 5.6s@225MB；minify 后体积约减半）。bytecode 预编译默认启用，把解析
  // 工作移到构建期：Bun 1.4 的 bytecode + format: 'esm' 组合支持 cli.tsx
  // 的顶层 await 与 cliHighlight.ts 的动态 import。
  const result = await Bun.build({
    entrypoints: ['src/entrypoints/cli.tsx'],
    target: 'bun',
    define: {
      ...getMacroDefines(),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    features,
    plugins: [
      createEmbeddedNativesPlugin(
        embeddedNatives,
        embeddedRipgrep,
        embeddedSearchTools,
      ),
    ],
    minify: true,
    format: 'esm',
    bytecode: true,
    compile: {
      // 单数 target 是唯一生效的 API：复数 targets 会被静默忽略，
      // 产物退化为 host 架构（CI x86 上曾把 arm64 名字编成 x86_64 ELF）。
      target,
      outfile: `dist/ccb-${target.replace(/^bun-/, '')}`,
    },
  })

  if (!result.success) {
    console.error(`compile failed for ${target}:`)
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }
  console.log(
    `compiled: dist/ccb-${target.replace(/^bun-/, '')}${target.endsWith('windows-x64') ? '.exe' : ''}`,
  )
}
