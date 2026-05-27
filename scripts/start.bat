@echo off
setlocal
cd /d "%~dp0.."
set "NODE_CMD="
where node >nul 2>nul
if %errorlevel% equ 0 (
    set "NODE_CMD=node"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
) else (
    echo ERROR: Node.js not found. Please install Node.js 22+ or add node to PATH.
    pause
    exit /b 1
)
"%NODE_CMD%" app\bot.mjs
pause
endlocal
