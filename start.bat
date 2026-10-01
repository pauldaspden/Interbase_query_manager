@echo off
title InterBase Query Manager
cd /d "%~dp0"
echo ============================================
echo   InterBase Query Manager
echo   Starting... Open http://localhost:5000
echo   Press Ctrl+C to stop.
echo ============================================
python app.py
pause
