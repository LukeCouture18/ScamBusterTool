@echo off
echo ========================================================
echo  Operation Hunter v2.0
echo ========================================================
if not exist dist\index.html (
    echo UI not built yet - running setup build...
    call npm run build
)
echo Starting on http://localhost:3000 ...
call npm start
pause
