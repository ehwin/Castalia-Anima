param(
  [Parameter(Mandatory=$true)][string]$TavernRoot,
  [string]$EngineRoot = (Resolve-Path "$PSScriptRoot/../..").Path,
  [string]$BankDir = "$EngineRoot/tavern-memory"
)
$ErrorActionPreference = 'Stop'
$resolvedTavern = (Resolve-Path -LiteralPath $TavernRoot).Path
if (!(Test-Path -LiteralPath "$resolvedTavern/public/scripts/extensions")) { throw 'TavernRoot 必须指向 SillyTavern 目录' }
if (!(Test-Path -LiteralPath "$EngineRoot/dist/tavern.js")) { throw '请先在 Anima 目录执行 npm run build' }
$extensionTarget = Join-Path $resolvedTavern 'public/scripts/extensions/third-party/castalia-anima'
$serverTarget = Join-Path $resolvedTavern 'plugins/castalia-anima'
$backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($target in @($extensionTarget, $serverTarget)) {
  if (Test-Path -LiteralPath $target) {
    $backupRoot = Join-Path $resolvedTavern "backups/castalia-anima-$backupStamp"
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Copy-Item -LiteralPath $target -Destination (Join-Path $backupRoot (Split-Path (Split-Path $target -Parent) -Leaf)) -Recurse
  }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
}
Copy-Item -Path "$PSScriptRoot/extension/*" -Destination $extensionTarget -Force
Copy-Item -Path "$PSScriptRoot/server/*" -Destination $serverTarget -Force
if (!(Test-Path -LiteralPath "$serverTarget/config.json")) {
  @{ engineRoot = [IO.Path]::GetFullPath($EngineRoot); bankDir = [IO.Path]::GetFullPath($BankDir); embedMode = 'none' } |
    ConvertTo-Json | Set-Content -LiteralPath "$serverTarget/config.json" -Encoding utf8NoBOM
}
Write-Output '已安装前端扩展和后端插件。config.yaml 需 enableServerPlugins: true，重启酒馆后生效。'
