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

if not exist "%~dp0data\runtime" mkdir "%~dp0data\runtime"
set "LOCK_FILE=%~dp0data\runtime\.wechat-aibot.lock"
set "BOT_PID="
if exist "%LOCK_FILE%" set /p BOT_PID=<"%LOCK_FILE%"

if defined BOT_PID (
    set "BOT_IS_OURS="
    for /f %%V in ('powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + !BOT_PID!) -ErrorAction SilentlyContinue; if($p -and $p.CommandLine -match 'app[\\/]bot\\.mjs'){ 'yes' }"') do set "BOT_IS_OURS=%%V"
    if /i "!BOT_IS_OURS!"=="yes" (
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
"%NODE_CMD%" app\bot.mjs

:end
pause
endlocal
