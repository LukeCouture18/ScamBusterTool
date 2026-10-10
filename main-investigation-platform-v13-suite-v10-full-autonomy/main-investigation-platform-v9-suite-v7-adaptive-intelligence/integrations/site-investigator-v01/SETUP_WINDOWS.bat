@echo off
setlocal
cd /d "%~dp0"
py -m venv .venv || exit /b 1
.venv\Scripts\python.exe -m pip install --upgrade pip || exit /b 1
.venv\Scripts\python.exe -m pip install -r requirements.txt || exit /b 1
.venv\Scripts\python.exe -m playwright install chromium || exit /b 1
echo Setup complete. Run START_WINDOWS.bat
pause

