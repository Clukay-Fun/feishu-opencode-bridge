@echo off
rem 职责: 兼容旧版 Windows 双击启动入口。
rem 关注点:
rem - 不再直接依赖系统 node，统一转发到 portable bridge 入口。
rem - 保持旧文件名可用，避免历史 README 或用户习惯失效。
rem - 无 config.json 时自动引导 setup 向导。
setlocal
cd /d "%~dp0"

rem 检测可用配置
set "CONFIG_FOUND="
if defined BRIDGE_CONFIG_PATH if exist "%BRIDGE_CONFIG_PATH%" set "CONFIG_FOUND=1"
if not defined CONFIG_FOUND if exist "%LOCALAPPDATA%\FeishuOpenCodeBridge\config.json" (
  set "BRIDGE_CONFIG_PATH=%LOCALAPPDATA%\FeishuOpenCodeBridge\config.json"
  set "CONFIG_FOUND=1"
)
if not defined CONFIG_FOUND if exist "%~dp0..\config.json" (
  set "BRIDGE_CONFIG_PATH=%~dp0..\config.json"
  set "CONFIG_FOUND=1"
)

rem 无配置时自动进入 setup 向导
if not defined CONFIG_FOUND (
  echo 首次启动，正在打开配置向导...
  call "%~dp0bridge.cmd" setup
  exit /b %errorlevel%
)

call "%~dp0bridge.cmd" start
exit /b %errorlevel%
