@echo off
rem 职责: 兼容旧版 Windows 双击启动入口。
rem 关注点:
rem - 不再直接依赖系统 node，统一转发到 portable bridge 入口。
rem - 保持旧文件名可用，避免历史 README 或用户习惯失效。
setlocal
cd /d "%~dp0"
if not defined BRIDGE_CONFIG_PATH if exist "%~dp0config.json" (
  if defined BRIDGE_HOME (
    set "PORTABLE_HOME=%BRIDGE_HOME%"
  ) else (
    set "PORTABLE_HOME=%LOCALAPPDATA%\FeishuOpenCodeBridge"
  )
  if not exist "%PORTABLE_HOME%\config.json" set "BRIDGE_CONFIG_PATH=%~dp0config.json"
)
call "%~dp0bridge.cmd" start
exit /b %errorlevel%
