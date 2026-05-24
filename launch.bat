@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo Starting WeChat AI Bot...
echo GUI will open automatically after login at http://127.0.0.1:18720
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

set "LOCK_FILE=%~dp0.wechat-aibot.lock"
set "BOT_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18720 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if($c){$c}"`) do set "BOT_PID=%%P"
if not defined BOT_PID if exist "%LOCK_FILE%" set /p BOT_PID=<"%LOCK_FILE%"

if defined BOT_PID (
    tasklist /FI "PID eq !BOT_PID!" 2>nul | findstr /R "\<!BOT_PID!\>" >nul
    if !errorlevel! equ 0 (
        echo Existing WeChat AI Bot instance: PID !BOT_PID!
        echo [O] Open GUI
        echo [R] Restart bot
        echo [Q] Quit
        choice /C ORQ /N /M "Choose: "
        if errorlevel 3 goto end
        if errorlevel 2 (
            taskkill /T /F /PID !BOT_PID!
            if exist "%LOCK_FILE%" del "%LOCK_FILE%" >nul 2>nul
            goto start_bot
        )
        start http://127.0.0.1:18720
        goto end
    )
)

:start_bot
"%NODE_CMD%" bot.mjs

:end
pause
endlocal
