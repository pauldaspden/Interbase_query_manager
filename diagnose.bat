@echo off
:: Diagnostic script — run as admin to see what's going on
cd /d "%~dp0"

echo === Admin Check ===
net session >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo NOT running as admin.
) else (
    echo Running as admin - OK.
)

echo.
echo === Paths ===
set PYTHONW=%~dp0python\pythonw.exe
set APP=%~dp0app.py
echo PYTHONW=%PYTHONW%
echo APP=%APP%
if exist "%PYTHONW%" (echo pythonw.exe exists - OK) else (echo pythonw.exe MISSING!)
if exist "%APP%" (echo app.py exists - OK) else (echo app.py MISSING!)

echo.
echo === Existing Task ===
schtasks /Query /TN "InterbaseQueryManager" 2>&1

echo.
echo === Creating Task ===
schtasks /Create /TN "InterbaseQueryManager" /TR "\"%PYTHONW%\" \"%APP%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F 2>&1

echo.
echo === Verify Task Created ===
schtasks /Query /TN "InterbaseQueryManager" /V /FO LIST 2>&1

echo.
echo === Starting Task ===
schtasks /Run /TN "InterbaseQueryManager" 2>&1

echo.
echo === Port 5000 Check ===
netstat -ano | findstr ":5000"

echo.
pause
