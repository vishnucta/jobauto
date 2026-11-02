@echo off
rem Updates jobauto to the latest release. Close the Jobauto window first.
setlocal
title Jobauto update
cd /d "%TEMP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\update.ps1"
if errorlevel 1 (
  echo.
  echo The update did not finish. Read the message above, then press any key to close this window.
  pause >nul
)
endlocal
