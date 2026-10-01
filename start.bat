@echo off
title InterBase Query Manager
cd /d "%~dp0"

set PYTHON_DIR=%~dp0python
set PYTHON_EXE=%PYTHON_DIR%\python.exe

if exist "%PYTHON_EXE%" (
    set PY=%PYTHON_EXE%
) else (
    set PY=python
)

:RESTART
REM ── Kill any existing instance on port 5000 ──
echo Stopping existing instance (if any)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5000.*LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul 2>&1

REM ── Remove stale restart flag ──
if exist ".restart_flag" del ".restart_flag"

REM ── Start the server ──
echo.
echo ============================================
echo   InterBase Query Manager
echo   Open http://localhost:5000 in your browser
echo   This window must stay open while using the app.
echo ============================================
echo.

"%PY%" app.py

REM ── Check if we should restart ──
if exist ".restart_flag" (
    echo.
    echo [Restart requested — restarting server...]
    del ".restart_flag"
    timeout /t 1 /nobreak >nul 2>&1
    goto RESTART
)

echo.
echo Server stopped. Press any key to exit.
pause >nul
