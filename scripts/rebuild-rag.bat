@echo off
cd /d "%~dp0.."
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "try{$c=Get-Content -Raw data\\config.json|ConvertFrom-Json;$c.proxy.https}catch{}"`) do set HTTP_PROXY=%%P
if defined HTTP_PROXY set HTTPS_PROXY=%HTTP_PROXY%
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
python -X utf8 app\rag.py build
pause
