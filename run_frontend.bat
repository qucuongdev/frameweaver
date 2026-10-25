@echo off
title FrameWeaver - Frontend (Port 5173)
cd /d "%~dp0dashboard"
echo ========================================================
echo   FrameWeaver Frontend dang khoi dong...
echo   Dashboard UI: http://localhost:5173
echo ========================================================
echo.
call npm run dev
pause
