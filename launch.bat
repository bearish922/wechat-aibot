@echo off
cd /d "%~dp0"
echo Starting WeChat AI Bot...
echo GUI will open automatically after login at http://127.0.0.1:18720
where node >nul 2>nul
if %errorlevel% equ 0 (
    node bot.mjs
) else if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" bot.mjs
) else (
    echo ERROR: Node.js not found. Please install Node.js 22+ or add node to PATH.
)
pause
