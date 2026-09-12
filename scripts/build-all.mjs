#!/usr/bin/env node
// 一体化构建 CLI：Rust native（多平台）→ claude code bundle（内嵌 .node）→ npm tarball
//
// usage:
//   node scripts/build-all.mjs                          # 全流程（native + build + pack）
//   node scripts/build-all.mjs --skip-native            # 跳过 cargo（CI 矩阵产物已在 vendor/ 时）
//   node scripts/build-all.mjs --platforms <t1,t2,...>  # 指定 triple（默认全部）
//   node scripts/build-all.mjs --skip-pack              # 只出 dist，不打 tgz
import { spawnSync } from 'node:child_process'
import { cp, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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

// ── Step 2: claude code bundle（build.ts 把 vendor/<name>/ 复制进 dist/vendor/）──
run('bun', ['run', 'build'])
console.log('step 2 (bundle): dist/ ready — dist/vendor 内嵌全部平台 .node')

// ── Step 3: npm tarball ──
if (!SKIP_PACK) {
  run('npm', ['pack', '--pack-destination', '.'])
  console.log(
    'step 3 (pack): *.tgz ready — npm i -g claude-code-best-*.tgz 即装即用',
  )
} else {
  console.log('step 3 (pack): skipped')
}

console.log('\nbuild-all: DONE')
