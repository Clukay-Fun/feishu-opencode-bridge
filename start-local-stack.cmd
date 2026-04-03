@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "OPEN_CODE_DIR=%SCRIPT_DIR%.."
set "OPEN_CODE_CLI=%OPEN_CODE_DIR%\opencode-cli.exe"

if not exist "%OPEN_CODE_CLI%" (
  echo Could not find "%OPEN_CODE_CLI%"
  exit /b 1
)

start "OpenCode Serve" cmd /k ""%OPEN_CODE_CLI%" serve"
start "Feishu Bridge" cmd /k "cd /d "%SCRIPT_DIR%" && npm run dev"
