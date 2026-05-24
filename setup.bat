@echo off
echo ============================================
echo  WeChat AI Bot Setup
echo ============================================
echo.
cd /d "%~dp0"

echo [1/3] Installing Node.js dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Python dependencies...
pip install -r requirements-rag.txt
if %errorlevel% neq 0 (
    echo WARNING: pip install failed. RAG features may not work.
)

echo.
echo [3/3] Setup complete!
echo.
echo Next steps:
echo  1. Copy config.example.json to config.json and edit it
echo  2. Run rebuild-rag.bat to build the knowledge base index
echo  3. Run launch.bat to start the bot
echo.
pause
