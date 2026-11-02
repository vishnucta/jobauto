@echo off
rem jobauto for Windows: double-click this file to install or update the app.
rem It runs app\installer\install.ps1 next to it; see README-Windows.txt.
setlocal
title Jobauto installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\installer\install.ps1"
if errorlevel 1 (
  echo.
  echo The installation did not finish. Read the message above, then press any key to close this window.
  pause >nul
)
endlocal
