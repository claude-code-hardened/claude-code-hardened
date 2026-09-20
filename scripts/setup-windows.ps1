# setup-windows.ps1 — Windows 上给 ccb 配齐 ripgrep / 可选单文件化
# 用法（PowerShell）：
#   cd <ccb 仓库根>
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1          # 只配 rg
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Compile # 再做单文件化
param(
  [switch]$Compile
)

$ErrorActionPreference = 'Stop'

# ── 1. ripgrep：下载 rg.exe 到 dist\vendor\ripgrep ──────────────────────────
# ccb 的 getRipgrepConfig 会按 distRoot/vendor/ripgrep 找平台二进制（win32 特判 .exe）
$rgVersion = '14.1.0'
$rgDir = Join-Path (Join-Path (Get-Location) 'dist') 'vendor\ripgrep'
$rgExe = Join-Path $rgDir 'rg.exe'

if (-not (Test-Path $rgExe)) {
  $zip = "ripgrep-$rgVersion-x86_64-pc-windows-msvc.zip"
  $url = "https://github.com/BurntSushi/ripgrep/releases/download/$rgVersion/$zip"
  Write-Host "下载 ripgrep $rgVersion ..."
  New-Item -ItemType Directory -Force -Path $rgDir | Out-Null
  $tmpZip = Join-Path $env:TEMP $zip
  Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing
  Expand-Archive -Path $tmpZip -DestinationPath $env:TEMP -Force
  Copy-Item (Join-Path $env:TEMP "ripgrep-$rgVersion-x86_64-pc-windows-msvc\rg.exe") $rgExe -Force
  Remove-Item $tmpZip, (Join-Path $env:TEMP "ripgrep-$rgVersion-x86_64-pc-windows-msvc") -Recurse -Force
  Write-Host "✓ rg.exe 已就位: $rgExe"
} else {
  Write-Host "✓ rg.exe 已存在: $rgExe"
}

# ── 2.（可选）单文件化：rg 从此内嵌进 bun 二进制，永远免装 ───────────────────
if ($Compile) {
  # 需要完整 node_modules（bun install 会拉依赖——磁盘紧张时先跳过）
  if (-not (Test-Path 'node_modules')) {
    Write-Host '拉取依赖（一次性，~1-2 GB）...'
    bun install
  }
  Write-Host 'bundle ...'
  bun run build.ts
  Write-Host 'compile 单文件（内嵌 ripgrep）...'
  $exe = Join-Path (Get-Location) 'ccb.exe'
  bun build --compile dist/entrypoints/cli.js --outfile $exe
  Write-Host "✓ 单文件产物: $exe（之后 rg 由 argv0='rg' 分发，isInBundledMode 自动启用）"
} else {
  # 非单文件模式下，若系统装了 rg 也可用 USE_BUILTIN_RIPGREP=0 走系统路径；
  # vendor 就位后无需任何 env，getRipgrepConfig 自动找到。
  Write-Host '完成。直接运行 dist\entrypoints\cli.js 即可（vendor rg 自动生效）。'
  Write-Host '要单文件化（rg 内嵌）加 -Compile 参数重跑。'
}
