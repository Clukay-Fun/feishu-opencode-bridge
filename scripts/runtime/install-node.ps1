<#
职责: 为 Windows portable 包下载并解压 Node.js。
关注点:
- 只写入项目 .runtime/node，不安装到系统目录。
- 根据当前 CPU 架构选择 Node 官方 zip。
- 由 bridge.cmd / bridge.ps1 调用，不依赖仓库内 Node 脚本。
#>
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Version = "v22.15.0"
)

$ErrorActionPreference = "Stop"
$runtimeDir = Join-Path $Root ".runtime"
$nodeDir = Join-Path $runtimeDir "node"
$tmpDir = Join-Path $runtimeDir "node-download"
$nodeExe = Join-Path $nodeDir "node.exe"

if (Test-Path $nodeExe) {
  Write-Host "检测到 portable Node: $nodeExe"
  exit 0
}

$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$name = "node-$Version-win-$arch"
$url = "https://nodejs.org/dist/$Version/$name.zip"
$zipPath = Join-Path $runtimeDir "$name.zip"

Write-Host "未检测到 Node，正在下载 portable Node $Version ($arch)，预计 30-60 秒..."
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
Remove-Item -Force $zipPath -ErrorAction SilentlyContinue

Invoke-WebRequest -Uri $url -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
Remove-Item -Recurse -Force $nodeDir -ErrorAction SilentlyContinue
Move-Item -Path (Join-Path $tmpDir $name) -Destination $nodeDir
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
Remove-Item -Force $zipPath -ErrorAction SilentlyContinue

if (!(Test-Path $nodeExe)) {
  throw "Node 下载完成但未找到 node.exe: $nodeExe"
}

Write-Host "portable Node 已就绪: $nodeExe"
