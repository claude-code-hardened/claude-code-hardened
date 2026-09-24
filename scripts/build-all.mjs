#!/usr/bin/env node
// 一体化构建 CLI：Rust native（多平台）→ claude code bundle（内嵌 .node）→ 单文件可执行二进制
//
// usage:
//   node scripts/build-all.mjs                          # 全流程（native + build + pack）
//   node scripts/build-all.mjs --skip-native            # 跳过 cargo（CI 矩阵产物已在 vendor/ 时）
//   node scripts/build-all.mjs --platforms <t1,t2,...>  # 指定 triple（默认全部）
//   node scripts/build-all.mjs --skip-pack              # 只出 dist，不打 tgz
import { spawnSync } from 'node:child_process'
import { cp, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const SKIP_NATIVE = flag('--skip-native')
const SKIP_PACK = flag('--skip-pack')
const PLATFORMS_ARG = args.indexOf('--platforms')

const ALL_PLATFORMS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
]
const platforms =
  PLATFORMS_ARG !== -1 && args[PLATFORMS_ARG + 1]
    ? args[PLATFORMS_ARG + 1].split(',')
    : ALL_PLATFORMS

// crate 名取 package name 的下划线形式 —— cdylib 产物名由 Cargo 自动下划线化
const CRATES = [
  {
    pkg: 'token-counter-napi',
    crate: 'token_counter_napi',
    name: 'token-counter',
  },
  {
    pkg: 'transcript-parser-napi',
    crate: 'transcript_parser_napi',
    name: 'transcript-parser',
  },
  { pkg: 'color-diff-napi', crate: 'color_diff_napi', name: 'color-diff' },
  { pkg: 'file-index-napi', crate: 'file_index_napi', name: 'file-index' },
]

function artifactName(crate, platform) {
  if (platform.endsWith('-windows-msvc')) return `${crate}.dll`
  if (platform.endsWith('-apple-darwin')) return `lib${crate}.dylib`
  return `lib${crate}.so`
}

function run(cmd, cmdArgs, opts = {}) {
  const label = `${cmd} ${cmdArgs.join(' ')}`
  console.log(`\n$ ${label}`)
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`FAILED (exit ${r.status}): ${label}`)
    process.exit(r.status ?? 1)
  }
}

function tripleToTarget(triple) {
  const map = {
    'x86_64-unknown-linux-gnu': 'bun-linux-x64',
    'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
    'aarch64-apple-darwin': 'bun-darwin-arm64',
    'x86_64-apple-darwin': 'bun-darwin-x64',
    'x86_64-pc-windows-msvc': 'bun-windows-x64',
    'aarch64-pc-windows-msvc': 'bun-windows-arm64',
  }
  return map[triple]
}

const host = `${process.platform}/${process.arch}`
console.log(`build-all: host=${host} platforms=[${platforms.join(', ')}]`)

// ── Step 1: Rust native（每个 crate × 每个 triple）──
if (!SKIP_NATIVE) {
  if (spawnSync('cargo', ['--version']).status !== 0) {
    console.error('cargo not found — install Rust or pass --skip-native')
    process.exit(1)
  }
  for (const { pkg, crate, name } of CRATES) {
    const nativeDir = join('packages', pkg, 'native')
    if (!existsSync(join(nativeDir, 'Cargo.toml'))) continue
    for (const platform of platforms) {
      run('cargo', ['build', '--release', '--target', platform], {
        cwd: nativeDir,
      })
      const src = join(
        nativeDir,
        'target',
        platform,
        'release',
        artifactName(crate, platform),
      )
      if (!existsSync(src)) {
        console.error(`MISSING artifact: ${src}`)
        process.exit(1)
      }
      const dest = join('vendor', name, platform)
      mkdirSync(dest, { recursive: true })
      cp(src, join(dest, `${name}.node`))
      console.log(`→ ${dest}/${name}.node`)
    }
  }
} else {
  console.log('step 1 (rust native): skipped')
}

// ── Step 1.5: bundle（cli.js + chunks + cli-node.js/cli-bun.js + vendor）──
// npm 包的 bin 指向 dist/cli-node.js（shebang node → import './cli.js'），
// 缺这一步时 tarball 里只有 ccb-* 单文件 binary，npm i -g 后入口不存在。
// compile（Step 2）与 bundle 互不依赖，但 bundle 必须先于 Step 4 pack。
console.log('\n=== Step 1.5: Bundle (splitting + dual entry points) ===')
run('bun', ['run', 'build'])

// ── Step 1.7: 确保每个 compile target 的 ripgrep 就位（compile.ts 内嵌）──
// CI package job 在单台 runner 上循环编译 5 平台，postinstall 只装本平台；
// 其余平台在这里按 target 预取（幂等，失败仅告警不阻塞——运行时回退链仍在）。
console.log('\n=== Step 1.7: Fetch ripgrep for all targets ===')
const rgFetch = spawnSync('node', ['scripts/fetch-rg.mjs'], {
  stdio: 'inherit',
})
if (rgFetch.status !== 0) {
  console.warn(
    `[build-all] fetch-rg exited ${rgFetch.status}; compile proceeds without some embedded rg`,
  )
}

// ── Step 2: 为每个 target 编译单文件二进制（内嵌对应平台的 .node）──
console.log('\n=== Step 2: Compile single-file binaries ===')
for (const platform of platforms) {
  const target = tripleToTarget(platform)
  if (!target) {
    console.warn(`  Unknown target for ${platform}, skipping`)
    continue
  }
  console.log(`\n--- Compiling for ${target} (${platform}) ---`)
  run('bun', ['run', 'scripts/compile.ts', target])
}

console.log('\n=== Step 3: Verify binaries ===')
for (const platform of platforms) {
  const target = tripleToTarget(platform)
  if (!target) continue
  const outfile = `dist/ccb-${target.replace(/^bun-/, '')}${target.endsWith('windows-x64') ? '.exe' : ''}`
  if (existsSync(outfile)) {
    const stats = statSync(outfile)
    console.log(`  ✓ ${outfile} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
  } else {
    console.log(`  ✗ ${outfile} NOT FOUND`)
  }
}

// ── Step 4: npm tarball ──
if (!SKIP_PACK) {
  run('npm', ['pack', '--pack-destination', '.'])
  console.log(
    'step 4 (pack): *.tgz ready — npm i -g claude-code-best-*.tgz 即装即用',
  )
} else {
  console.log('step 4 (pack): skipped')
}

console.log('\nbuild-all: DONE')
