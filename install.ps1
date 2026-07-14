# 辰屿 Pro Skill 一行安装（Windows）：
#   irm https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main/install.ps1 | iex
# 装到 Codex + Claude Code 的 skills 目录，并创建全局 chenyu-pro 命令。需 Node 18+。
$ErrorActionPreference = "Stop"
$repo = "https://raw.githubusercontent.com/hieason4567-jpg/chenyu-pro-skill/main"
$files = @("SKILL.md", "scripts/chenyu_pro_cli.mjs")

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

Write-Host ""
& node $cliPath help | Select-Object -First 2
Write-Host ""
Write-Host "Install complete. First use:" -ForegroundColor Green
Write-Host "  chenyu-pro key set <credit-key>   (auto sign-in, no password needed)"
Write-Host "  chenyu-pro credits"
exit 0
