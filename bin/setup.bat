@echo off
rem 职责: 兼容旧版 Windows 双击安装入口。
rem 关注点:
rem - 不再维护独立 winget 安装逻辑，统一转发到 portable bridge 入口。
rem - 保持旧文件名可用，避免历史 README 或用户习惯失效。
setlocal
cd /d "%~dp0"
call "%~dp0bridge.cmd" onboard
exit /b %errorlevel%
