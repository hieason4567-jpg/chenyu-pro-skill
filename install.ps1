# 辰屿 Pro Skill 一行安装（Windows）：
#   irm https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main/install.ps1 | iex
# 装到 Codex + Claude Code 的 skills 目录，并创建全局 chenyu-pro 命令。需 Node 18+。
$ErrorActionPreference = "Stop"
$repo = "https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main"
$files = @("SKILL.md", "scripts/chenyu_pro_cli.mjs", "scripts/net.mjs", "scripts/asset_workbook.mjs", "scripts/wash_check.mjs", "scripts/deliver_check.mjs", "scripts/asset_export.mjs", "scripts/variant_candidates.mjs", "scripts/merge_review.mjs", "scripts/durations.mjs", "scripts/styling_static.json", "scripts/styling_audit.mjs", "scripts/remake.mjs", "scripts/excel_import.mjs", "scripts/storyboard_audit.mjs")

$roots = @()
$roots += Join-Path $env:USERPROFILE ".codex\skills"
$roots += Join-Path $env:USERPROFILE ".claude\skills"

$primary = ""
foreach ($root in $roots) {
  $dest = Join-Path $root "chenyu-pro"
  New-Item -ItemType Directory -Force (Join-Path $dest "scripts") | Out-Null
  foreach ($f in $files) {
    $target = Join-Path $dest ($f -replace "/", "\")
    Invoke-WebRequest -UseBasicParsing -Uri "$repo/$f" -OutFile $target
  }
  if (-not $primary) { $primary = $dest }
  Write-Host "  Skill installed -> $dest"
}

# 全局 chenyu-pro 命令
$binDir = Join-Path $env:USERPROFILE ".codex\bin"
New-Item -ItemType Directory -Force $binDir | Out-Null
$cliPath = Join-Path $primary "scripts\chenyu_pro_cli.mjs"
Set-Content -Path (Join-Path $binDir "chenyu-pro.cmd") -Encoding ascii -Value "@echo off`r`nnode `"$cliPath`" %*"
Write-Host "  Command created -> $binDir\chenyu-pro.cmd"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
  Write-Host "  PATH updated (new terminals will have chenyu-pro)"
}

# 自带 ffmpeg：视频上传前必须压缩，本机没有 ffmpeg 就下载一份（约 29MB，只下一次；有系统代理会走代理）。
# 下载失败不影响安装，第一次分析视频时还会再试。
Write-Host ""
Write-Host "  Checking ffmpeg (needed to compress videos before upload)..."
& node $cliPath ffmpeg --install

Write-Host ""
Write-Host "Install complete." -ForegroundColor Green
# 使用说明：node 直接写终端（不经过管道，避免 PowerShell 把中文转成乱码）
& node $cliPath guide
# 不要 exit：用 irm | iex 运行时 exit 会直接关掉用户的 PowerShell 窗口，看不到安装结果
