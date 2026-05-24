@echo off
setlocal enabledelayedexpansion

set "MEDIA_DIR=%~dp0inbound_media"
set "DEFAULT_DAYS=30"

if not exist "%MEDIA_DIR%" (
    echo inbound_media directory not found: %MEDIA_DIR%
    exit /b 1
)

if "%~1"=="" (
    set "DAYS=%DEFAULT_DAYS%"
) else (
    set "DAYS=%~1"
)

REM Validate DAYS is a positive integer
set "NUM_TEST=%DAYS%"
for /f "delims=0123456789" %%a in ("!NUM_TEST!") do set "NUM_TEST=%%a"
if not "!NUM_TEST!"=="" (
    echo Error: days must be a positive integer, got: %DAYS%
    exit /b 1
)
if %DAYS% LEQ 0 (
    echo Error: days must be a positive integer, got: %DAYS%
    exit /b 1
)

echo ============================================
echo  Media Cleanup Tool
echo  Directory: %MEDIA_DIR%
echo  Keep files newer than %DAYS% days
echo ============================================
echo.

REM Calculate cutoff date using PowerShell
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddDays(-%DAYS%).ToString('yyyy-MM-dd')"') do set "CUTOFF_DATE=%%i"

echo Cutoff date: %CUTOFF_DATE%
echo Files modified before this date will be deleted.
echo.

REM Count files
set "FILE_COUNT=0"
for %%f in ("%MEDIA_DIR%\*") do set /a FILE_COUNT+=1
echo Total files in directory: %FILE_COUNT%

if %FILE_COUNT% EQU 0 (
    echo No files to clean up.
    goto :end
)

REM Show size info via PowerShell
echo.
echo File summary:
powershell -NoProfile -Command "$dir='%MEDIA_DIR%'; $cutoff=(Get-Date).AddDays(-%DAYS%); $files=Get-ChildItem $dir -File; $old=$files|Where-Object{$_.LastWriteTime -lt $cutoff}; Write-Host ('  Total: {0} files, {1:F1} MB' -f $files.Count,($files|Measure-Object Length -Sum).Sum/1MB); Write-Host ('  Older than %DAYS%d: {0} files, {1:F1} MB' -f $old.Count,($old|Measure-Object Length -Sum).Sum/1MB)"

echo.
echo ============================================
echo  WARNING: This will permanently delete files.
echo  Press Ctrl+C to cancel, or
set /p "CONFIRM=Type 'yes' to confirm deletion: "

if /i not "!CONFIRM!"=="yes" (
    echo Cancelled.
    goto :end
)

echo.
echo Deleting files older than %DAYS% days...

set "DEL_COUNT=0"
set "ERR_COUNT=0"
for %%f in ("%MEDIA_DIR%\*") do (
    set "FILE_PATH=%%f"
    for /f %%t in ('powershell -NoProfile -Command "(Get-Item '!FILE_PATH!').LastWriteTime -lt (Get-Date).AddDays(-%DAYS%)"') do set "IS_OLD=%%t"
    if "!IS_OLD!"=="True" (
        del "%%f" 2>nul
        if errorlevel 1 (
            set /a ERR_COUNT+=1
            echo   [FAIL] %%~nxf
        ) else (
            set /a DEL_COUNT+=1
        )
    )
)

echo.
echo ============================================
echo  Done: deleted %DEL_COUNT% files
if %ERR_COUNT% GTR 0 echo  Failed: %ERR_COUNT% files
echo ============================================

:end
endlocal
