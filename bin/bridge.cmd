@echo off
rem 职责: Windows portable 包统一入口。
rem 关注点:
rem - 优先使用包内 .runtime\node，不要求用户预装 Node。
rem - 缺 Node 时自动下载 portable Node。
rem - 后续命令统一交给 scripts\runtime\bootstrap.mjs。
setlocal
cd /d "%~dp0"

set "ROOT=%~dp0..\"
set "NODE_EXE=%ROOT%.runtime\node\node.exe"

if exist "%NODE_EXE%" goto run

for %%I in (node.exe) do set "SYSTEM_NODE=%%~$PATH:I"
if defined SYSTEM_NODE (
  set "NODE_EXE=%SYSTEM_NODE%"
  goto run
)

echo 未检测到 Node，准备下载 portable Node...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\runtime\install-node.ps1" -Root "%ROOT%"
if errorlevel 1 exit /b %errorlevel%
set "NODE_EXE=%ROOT%.runtime\node\node.exe"

:run
if not defined BRIDGE_HOME set "BRIDGE_HOME=%LOCALAPPDATA%\FeishuOpenCodeBridge"
"%NODE_EXE%" "%ROOT%scripts\runtime\bootstrap.mjs" %*
exit /b %errorlevel%
