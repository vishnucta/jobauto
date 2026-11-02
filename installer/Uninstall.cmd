@echo off
rem Removes jobauto from this computer. Close the Jobauto window first.
setlocal
title Jobauto uninstall
cd /d "%TEMP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\uninstall.ps1"
if errorlevel 1 (
  echo.
  echo Removing did not finish. Read the message above, then press any key to close this window.
  pause >nul
)
endlocal
