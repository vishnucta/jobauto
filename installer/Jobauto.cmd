@echo off
rem Starts jobauto. Installed next to the app by install.ps1; the Desktop shortcut points here.
title Jobauto
set "PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"
cd /d "%~dp0app"
echo Starting Jobauto. Leave this window open while you use the app; close it to stop.
echo The browser opens by itself when the app is ready, at http://localhost:3000
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0installer\open-when-ready.ps1"
call yarn dev
if errorlevel 1 (
  echo.
  echo The app stopped with an error. Read the message above, then press any key to close this window.
  pause >nul
)
