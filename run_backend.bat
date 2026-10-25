@echo off
title FrameWeaver - Backend (Port 8100)
cd /d "%~dp0"
echo ========================================================
echo   FrameWeaver Backend dang khoi dong...
echo   API Server: http://127.0.0.1:8100
echo   Swagger UI: http://127.0.0.1:8100/docs
echo   Extension WS: ws://127.0.0.1:9222
echo ========================================================
echo.
.venv\Scripts\python.exe -m agent.main
pause
