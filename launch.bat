@echo off
cd /d "%~dp0"
echo Starting WeChat AI Bot...
echo GUI will open automatically after login at http://127.0.0.1:18720
"C:\Program Files\nodejs\node.exe" bot.mjs
pause
