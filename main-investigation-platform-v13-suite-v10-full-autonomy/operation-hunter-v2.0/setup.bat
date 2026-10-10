@echo off
echo ========================================================
echo  Operation Hunter v2.0 - Setup
echo ========================================================
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js 22.13 or newer is required ^(built-in SQLite^). Install it from https://nodejs.org/
    pause
    exit /b 1
)
echo Installing dependencies...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)
echo Building the user interface...
call npm run build
if errorlevel 1 (
    echo [ERROR] UI build failed.
    pause
    exit /b 1
)
if not exist .env copy .env.example .env >nul
echo.
echo Setup complete. Run start.bat to launch Operation Hunter on http://localhost:3000
echo Your v0.x data in data\hunter_store.json is imported automatically on first start (a backup is kept).
echo.
pause
