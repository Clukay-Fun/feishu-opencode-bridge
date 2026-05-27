<#
职责: Windows PowerShell portable 包统一入口。
关注点:
- 优先使用包内 .runtime\node，不要求用户预装 Node。
- 缺 Node 时自动下载 portable Node。
- 后续命令统一交给 scripts\runtime\bootstrap.mjs。
#>
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$BridgeArgs
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $Root ".runtime\node\node.exe"

if (!(Test-Path $NodeExe)) {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) {
    $NodeExe = $systemNode.Source
  } else {
    Write-Host "未检测到 Node，准备下载 portable Node..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\runtime\install-node.ps1") -Root $Root
    $NodeExe = Join-Path $Root ".runtime\node\node.exe"
  }
}

if (!$env:BRIDGE_HOME) {
  $env:BRIDGE_HOME = Join-Path $env:LOCALAPPDATA "FeishuOpenCodeBridge"
}

& $NodeExe (Join-Path $Root "scripts\runtime\bootstrap.mjs") @BridgeArgs
exit $LASTEXITCODE
