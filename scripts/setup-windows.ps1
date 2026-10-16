# setup-windows.ps1 — Windows 上的可选单文件化构建说明
# 用法（PowerShell）：
#   cd <cch 仓库根>
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
#
# （原 ripgrep 下载段已随 rg 外挂链整体退役删除：搜索由进程内
#  search-napi 承接，CCH 不再自带/下载 rg 二进制；沙箱内如需 rg 由
#  用户 PATH 提供。）
param(
  [switch]$Compile
)

$ErrorActionPreference = 'Stop'

# ──（可选）单文件化 ─────────────────────────────────────────────────────────
if ($Compile) {
  # 需要完整 node_modules（bun install 会拉依赖——磁盘紧张时先跳过）
  if (-not (Test-Path 'node_modules')) {
    Write-Host '拉取依赖（一次性，~1-2 GB）...'
    bun install
  }
  Write-Host '构建 ...'
  bun run build.ts
  Write-Host 'compile 单文件（内嵌 search-napi 等 native 模块）...'
  $exe = Join-Path (Get-Location) 'cch.exe'
  bun run scripts/compile.ts bun-windows-x64
  Write-Host '✓ 单文件产物: dist/cch-windows-x64.exe'
} else {
  Write-Host '完成。日常开发直接 bun run dev；单文件产物走 bun run build:all。'
}
