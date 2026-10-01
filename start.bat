@echo off
title InterBase Query Manager
cd /d "%~dp0"

REM ── Use bundled portable Python (no installation needed) ──
set PYTHON_DIR=%~dp0python
set PYTHON_EXE=%PYTHON_DIR%\python.exe

if exist "%PYTHON_EXE%" (
    echo ============================================
    echo   InterBase Query Manager
    echo   Using bundled Python: %PYTHON_EXE%
    echo   Open http://localhost:5000 in your browser
    echo   Press Ctrl+C to stop.
    echo ============================================
    "%PYTHON_EXE%" app.py
) else (
    echo ============================================
    echo   InterBase Query Manager
    echo   No bundled Python found.
    echo   Trying system Python...
    echo ============================================
    python app.py
)

pause
