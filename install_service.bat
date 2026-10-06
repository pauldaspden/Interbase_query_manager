@echo off
:: ── Install InterBase Query Manager as a persistent scheduled task ──
:: 
:: IMPORTANT: Right-click this file and choose "Run as administrator"
:: Or run it from an elevated (admin) Command Prompt.
:: This script does NOT auto-elevate to avoid window loops.

cd /d "%~dp0"

:: Check for admin rights
net session >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo ============================================
    echo   ERROR: This script needs admin rights.
    echo   Right-click and choose "Run as administrator"
    echo   Or open an admin Command Prompt and run it there.
    echo ============================================
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Installing InterBase Query Manager
echo ============================================
echo.

set PYTHONW=%~dp0python\pythonw.exe
set APP=%~dp0app.py
set TASKNAME=InterbaseQueryManager

echo   Python: %PYTHONW%
echo   App:    %APP%
echo.

:: Remove existing task if present
schtasks /Delete /TN "%TASKNAME%" /F >nul 2>&1

:: Create the scheduled task (runs at startup as SYSTEM)
echo Creating scheduled task...
schtasks /Create /TN "%TASKNAME%" /TR "\"%PYTHONW%\" \"%APP%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F

if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Failed to create scheduled task (error %ERRORLEVEL%).
    echo.
    pause
    exit /b 1
)

:: Start it now
echo.
echo Starting the task now...
schtasks /Run /TN "%TASKNAME%"

echo.
echo ============================================
echo   Done! InterBase Query Manager is installed.
echo   Open http://localhost:5000 in your browser.
echo   It will auto-start on boot and survive logoff.
echo ============================================
echo.
echo Press any key to close...
pause >nul
