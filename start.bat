@echo off
rem 职责: 兼容旧版 Windows 双击启动入口。
rem 关注点:
rem - 不再直接依赖系统 node，统一转发到 portable bridge 入口。
rem - 保持旧文件名可用，避免历史 README 或用户习惯失效。
setlocal
cd /d "%~dp0"
call "%~dp0bridge.cmd" start
exit /b %errorlevel%
