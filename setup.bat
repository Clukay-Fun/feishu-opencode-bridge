@echo off
setlocal
cd /d "%~dp0"
call :resolve_node
if errorlevel 1 (
  where winget >nul 2>&1
  if errorlevel 1 (
    echo 未检测到 Node.js，请先安装 Node.js 20+ 后重试。
    exit /b 1
  )
  echo 未检测到 Node.js，正在通过 winget 安装...
  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  if errorlevel 1 exit /b 1
  call :resolve_node
  if errorlevel 1 (
    echo Node.js 已安装，但当前 cmd 会话仍无法定位 node。请重新打开终端后重试。
    exit /b 1
  )
)
"%NODE_EXE%" scripts\onboard.mjs
exit /b %errorlevel%

:resolve_node
set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE if defined ProgramFiles(x86) if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE exit /b 1
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"
exit /b 0
